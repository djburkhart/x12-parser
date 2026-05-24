import type { FormattedSegment } from './types.js';
import type {
  AcknowledgmentInfo,
  EdiDocument,
  EdiElement,
  EdiSegment,
  ValidationIssue,
  ValidationReport,
} from './EdiTypes.js';
import { Segment } from './Segment.js';
import { X12parser } from './X12parser.js';

const X12_SYNTAX = {
  segmentTerminator: '~',
  elementSeparator: '*',
  componentSeparator: ':',
  repetitionSeparator: '^',
} as const;

type ResolvedX12Syntax = EdiDocument['syntax'] & {
  repetitionSeparator: string;
};

function stripNewLines(value: string): string {
  return value.replace(/\n/g, '');
}

function assertX12Document(document: EdiDocument): void {
  if (document.standard !== 'x12') {
    throw new TypeError('Expected an X12 document');
  }
}

function splitX12Segments(input: string): {
  rawSegments: string[];
  syntax: ResolvedX12Syntax;
} {
  const normalized = input.replace(/\r\n/g, '\n');
  const delimiters = X12parser.detectDelimiters(normalized);
  const segmentTerminator = delimiters.segment || '\n';
  const cleaned = normalized
    .replace(new RegExp(`^\\${segmentTerminator}+`), '')
    .replace(new RegExp(`\\${segmentTerminator}+$`), '');

  return {
    rawSegments: cleaned.split(segmentTerminator).filter((segment) => segment.trim() !== ''),
    syntax: {
      segmentTerminator,
      elementSeparator: delimiters.element || X12_SYNTAX.elementSeparator,
      componentSeparator: delimiters.component || X12_SYNTAX.componentSeparator,
      repetitionSeparator:
        delimiters.repetition || X12_SYNTAX.repetitionSeparator,
    },
  };
}

function parseX12Element(
  tag: string,
  rawElement: string,
  componentSeparator: string
): EdiElement {
  if (tag === 'ISA') {
    return stripNewLines(rawElement);
  }

  const components = rawElement
    .split(componentSeparator)
    .map((component) => stripNewLines(component));

  return components.length > 1 ? components : components[0];
}

function buildEnvelope(segments: EdiSegment[]): EdiDocument['envelope'] {
  const isa = segments.find((segment) => segment.tag === 'ISA');
  const gs = segments.find((segment) => segment.tag === 'GS');
  const st = segments.find((segment) => segment.tag === 'ST');

  return {
    senderId: typeof isa?.elements[5] === 'string' ? isa.elements[5] : undefined,
    receiverId:
      typeof isa?.elements[7] === 'string' ? isa.elements[7] : undefined,
    version: typeof gs?.elements[7] === 'string' ? gs.elements[7] : undefined,
    transactionType:
      typeof st?.elements[0] === 'string' ? st.elements[0] : undefined,
    interchangeControlNumber:
      typeof isa?.elements[12] === 'string' ? isa.elements[12] : undefined,
    groupControlNumber:
      typeof gs?.elements[5] === 'string' ? gs.elements[5] : undefined,
    transactionControlNumber:
      typeof st?.elements[1] === 'string' ? st.elements[1] : undefined,
  };
}

function stringifyElement(
  value: EdiElement,
  componentSeparator: string
): string {
  return Array.isArray(value) ? value.join(componentSeparator) : value;
}

export function parseX12(input: string): EdiDocument {
  const { rawSegments, syntax } = splitX12Segments(input);
  const segments = rawSegments.map((rawSegment) => {
    const [rawTag, ...parts] = rawSegment.split(syntax.elementSeparator);
    const tag = stripNewLines(rawTag).trim();

    return {
      tag,
      elements: parts.map((part) =>
        parseX12Element(tag, part, syntax.componentSeparator)
      ),
    };
  });

  return {
    standard: 'x12',
    syntax,
    segments,
    envelope: buildEnvelope(segments),
  };
}

export function parseX12Formatted(input: string): FormattedSegment[] {
  const { rawSegments, syntax } = splitX12Segments(input);
  const delimiters = {
    segment: syntax.segmentTerminator,
    component: syntax.componentSeparator,
    element: syntax.elementSeparator,
    repetition: syntax.repetitionSeparator,
  };

  return rawSegments.map((rawSegment) => new Segment(rawSegment, delimiters).formatted);
}

export function generateX12(document: EdiDocument): string {
  assertX12Document(document);

  return document.segments
    .map((segment) => {
      const body = segment.elements
        .map((element) =>
          stringifyElement(element, document.syntax.componentSeparator)
        )
        .join(document.syntax.elementSeparator);

      return [segment.tag, body]
        .filter((part, index) => index === 0 || part !== '')
        .join(document.syntax.elementSeparator);
    })
    .join(document.syntax.segmentTerminator)
    .concat(document.syntax.segmentTerminator);
}

function addIssue(
  issues: ValidationIssue[],
  issue: Omit<ValidationIssue, 'severity'> & { severity?: ValidationIssue['severity'] }
): void {
  issues.push({
    severity: issue.severity ?? 'error',
    ...issue,
  });
}

function readString(element: EdiElement | undefined): string | undefined {
  return typeof element === 'string' ? element.trim() : undefined;
}

export function validateX12(document: EdiDocument): ValidationReport {
  assertX12Document(document);
  const issues: ValidationIssue[] = [];

  const firstTag = document.segments[0]?.tag;
  const lastTag = document.segments.at(-1)?.tag;

  if (firstTag !== 'ISA') {
    addIssue(issues, {
      code: 'x12-envelope-start',
      message: 'X12 interchange must start with ISA',
      segmentTag: firstTag,
      segmentIndex: 0,
    });
  }

  if (lastTag !== 'IEA') {
    addIssue(issues, {
      code: 'x12-envelope-end',
      message: 'X12 interchange must end with IEA',
      segmentTag: lastTag,
      segmentIndex: document.segments.length - 1,
    });
  }

  const isa = document.segments.find((segment) => segment.tag === 'ISA');
  const iea = document.segments.find((segment) => segment.tag === 'IEA');
  if (
    isa &&
    iea &&
    readString(isa.elements[12]) !== readString(iea.elements[1])
  ) {
    addIssue(issues, {
      code: 'x12-interchange-control',
      message: 'ISA13 must match IEA02',
      segmentTag: 'IEA',
    });
  }

  let groupControl: string | undefined;
  let expectedTransactions = 0;
  let actualTransactions = 0;
  let openGroups = 0;
  let interchangeGroups = 0;
  let currentTransaction:
    | { controlNumber?: string; startIndex: number; countedSegments: number }
    | undefined;

  document.segments.forEach((segment, index) => {
    if (currentTransaction) {
      currentTransaction.countedSegments++;
    }

    switch (segment.tag) {
      case 'GS':
        openGroups++;
        interchangeGroups++;
        groupControl = readString(segment.elements[5]);
        actualTransactions = 0;
        break;
      case 'ST':
        currentTransaction = {
          controlNumber: readString(segment.elements[1]),
          startIndex: index,
          countedSegments: 1,
        };
        break;
      case 'SE':
        if (!currentTransaction) {
          addIssue(issues, {
            code: 'x12-se-without-st',
            message: 'SE segment encountered without an open ST transaction',
            segmentTag: 'SE',
            segmentIndex: index,
          });
          break;
        }

        if (
          readString(segment.elements[1]) !== currentTransaction.controlNumber
        ) {
          addIssue(issues, {
            code: 'x12-transaction-control',
            message: 'ST02 must match SE02',
            segmentTag: 'SE',
            segmentIndex: index,
          });
        }

        if (
          Number(readString(segment.elements[0])) !==
          currentTransaction.countedSegments
        ) {
          addIssue(issues, {
            code: 'x12-segment-count',
            message: 'SE01 must equal the number of segments between ST and SE',
            segmentTag: 'SE',
            segmentIndex: index,
          });
        }

        actualTransactions++;
        currentTransaction = undefined;
        break;
      case 'GE':
        expectedTransactions = Number(readString(segment.elements[0]) ?? '0');
        if (expectedTransactions !== actualTransactions) {
          addIssue(issues, {
            code: 'x12-group-count',
            message: 'GE01 must equal the number of ST/SE transactions in the group',
            segmentTag: 'GE',
            segmentIndex: index,
          });
        }

        if (readString(segment.elements[1]) !== groupControl) {
          addIssue(issues, {
            code: 'x12-group-control',
            message: 'GS06 must match GE02',
            segmentTag: 'GE',
            segmentIndex: index,
          });
        }

        openGroups--;
        groupControl = undefined;
        break;
      case 'IEA':
        if (Number(readString(segment.elements[0]) ?? '0') !== interchangeGroups) {
          addIssue(issues, {
            code: 'x12-interchange-count',
            message: 'IEA01 must equal the number of GS/GE groups in the interchange',
            segmentTag: 'IEA',
            segmentIndex: index,
          });
        }
        break;
      default:
        break;
    }
  });

  if (currentTransaction) {
    addIssue(issues, {
      code: 'x12-open-transaction',
      message: 'Encountered an ST without a matching SE',
      segmentTag: 'ST',
      segmentIndex: currentTransaction.startIndex,
    });
  }

  if (openGroups !== 0) {
    addIssue(issues, {
      code: 'x12-open-group',
      message: 'Encountered a GS without a matching GE',
      segmentTag: 'GS',
    });
  }

  return {
    standard: 'x12',
    valid: issues.every((issue) => issue.severity !== 'error'),
    issues,
  };
}

export function detectX12Acknowledgment(
  document: EdiDocument
): AcknowledgmentInfo | null {
  assertX12Document(document);
  const transaction = document.segments.find((segment) => segment.tag === 'ST');
  const transactionType = readString(transaction?.elements[0]);

  if (transactionType !== '997' && transactionType !== '999') {
    return null;
  }

  return {
    standard: 'x12',
    type: transactionType,
    controlNumber: readString(transaction?.elements[1]),
  };
}
