import type {
  AcknowledgmentInfo,
  EdiDocument,
  EdiElement,
  EdiSegment,
  ValidationIssue,
  ValidationReport,
} from './EdiTypes.js';

const DEFAULT_EDIFACT_SYNTAX = {
  componentSeparator: ':',
  elementSeparator: '+',
  decimalMark: '.',
  releaseCharacter: '?',
  segmentTerminator: "'",
} as const;

function assertEdifactDocument(document: EdiDocument): void {
  if (document.standard !== 'edifact') {
    throw new TypeError('Expected an EDIFACT document');
  }
}

function splitEscaped(
  input: string,
  separator: string,
  releaseCharacter: string
): string[] {
  const output = [''];

  for (let index = 0; index < input.length; index++) {
    const current = input[index];
    const next = input[index + 1];
    if (
      current === releaseCharacter &&
      index + 1 < input.length &&
      (next === separator || next === releaseCharacter)
    ) {
      output[output.length - 1] += next;
      index++;
      continue;
    }

    if (current === separator) {
      output.push('');
      continue;
    }

    output[output.length - 1] += current;
  }

  return output;
}

function escapeEdifactValue(value: string, document: EdiDocument): string {
  return value.replace(
    new RegExp(
      `[${document.syntax.releaseCharacter}\\${document.syntax.componentSeparator}\\${document.syntax.elementSeparator}\\${document.syntax.segmentTerminator}]`,
      'g'
    ),
    `${document.syntax.releaseCharacter}$&`
  );
}

function readString(element: EdiElement | undefined): string | undefined {
  return typeof element === 'string' ? element : undefined;
}

function buildEnvelope(segments: EdiSegment[]): EdiDocument['envelope'] {
  const unb = segments.find((segment) => segment.tag === 'UNB');
  const unh = segments.find((segment) => segment.tag === 'UNH');
  const versionElement = unh?.elements[1];

  return {
    senderId:
      Array.isArray(unb?.elements[1]) && typeof unb.elements[1][0] === 'string'
        ? unb.elements[1][0]
        : undefined,
    receiverId:
      Array.isArray(unb?.elements[2]) && typeof unb.elements[2][0] === 'string'
        ? unb.elements[2][0]
        : undefined,
    version:
      Array.isArray(versionElement) && typeof versionElement[2] === 'string'
        ? versionElement[2]
        : undefined,
    transactionType:
      Array.isArray(versionElement) && typeof versionElement[0] === 'string'
        ? versionElement[0]
        : undefined,
    interchangeControlNumber: readString(unb?.elements[4]),
    transactionControlNumber: readString(unh?.elements[0]),
  };
}

export function parseEdifact(input: string): EdiDocument {
  const normalized = input.replace(/\r\n/g, '\n').trim();
  const includeSyntaxSegment = normalized.startsWith('UNA');
  const syntax = includeSyntaxSegment
    ? {
        componentSeparator: normalized[3],
        elementSeparator: normalized[4],
        decimalMark: normalized[5],
        releaseCharacter: normalized[6],
        segmentTerminator: normalized[8],
      }
    : { ...DEFAULT_EDIFACT_SYNTAX };
  const body = includeSyntaxSegment ? normalized.slice(9) : normalized;
  const rawSegments = splitEscaped(
    body,
    syntax.segmentTerminator,
    syntax.releaseCharacter
  ).filter((segment) => segment.trim() !== '');

  const segments = rawSegments.map((rawSegment) => {
    const [rawTag, ...parts] = splitEscaped(
      rawSegment,
      syntax.elementSeparator,
      syntax.releaseCharacter
    );
    const tag = rawTag.trim();

    return {
      tag,
      elements: parts.map((part) => {
        const components = splitEscaped(
          part,
          syntax.componentSeparator,
          syntax.releaseCharacter
        ).map((value) => value.trim());

        return components.length > 1 ? components : components[0];
      }),
    };
  });

  return {
    standard: 'edifact',
    syntax,
    segments,
    envelope: buildEnvelope(segments),
    includeSyntaxSegment,
  };
}

export function generateEdifact(document: EdiDocument): string {
  assertEdifactDocument(document);

  const serialized = document.segments
    .map((segment) => {
      const elements = segment.elements.map((element) => {
        if (Array.isArray(element)) {
          return element
            .map((value) => escapeEdifactValue(value, document))
            .join(document.syntax.componentSeparator);
        }

        return escapeEdifactValue(element, document);
      });

      return [segment.tag, ...elements].join(document.syntax.elementSeparator);
    })
    .join(document.syntax.segmentTerminator)
    .concat(document.syntax.segmentTerminator);

  if (!document.includeSyntaxSegment) {
    return serialized;
  }

  return `UNA${document.syntax.componentSeparator}${document.syntax.elementSeparator}${document.syntax.decimalMark}${document.syntax.releaseCharacter} ${document.syntax.segmentTerminator}${serialized}`;
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

export function validateEdifact(document: EdiDocument): ValidationReport {
  assertEdifactDocument(document);
  const issues: ValidationIssue[] = [];

  if (document.segments[0]?.tag !== 'UNB') {
    addIssue(issues, {
      code: 'edifact-envelope-start',
      message: 'EDIFACT interchange must start with UNB',
      segmentTag: document.segments[0]?.tag,
      segmentIndex: 0,
    });
  }

  if (document.segments.at(-1)?.tag !== 'UNZ') {
    addIssue(issues, {
      code: 'edifact-envelope-end',
      message: 'EDIFACT interchange must end with UNZ',
      segmentTag: document.segments.at(-1)?.tag,
      segmentIndex: document.segments.length - 1,
    });
  }

  const unb = document.segments.find((segment) => segment.tag === 'UNB');
  const unz = document.segments.find((segment) => segment.tag === 'UNZ');
  if (
    readString(unb?.elements[4]) &&
    readString(unb?.elements[4]) !== readString(unz?.elements[1])
  ) {
    addIssue(issues, {
      code: 'edifact-interchange-control',
      message: 'UNB5 must match UNZ2',
      segmentTag: 'UNZ',
    });
  }

  let messageCount = 0;
  let openMessage:
    | { controlNumber?: string; countedSegments: number; startIndex: number }
    | undefined;

  document.segments.forEach((segment, index) => {
    if (openMessage) {
      openMessage.countedSegments++;
    }

    switch (segment.tag) {
      case 'UNH':
        openMessage = {
          controlNumber: readString(segment.elements[0]),
          countedSegments: 1,
          startIndex: index,
        };
        break;
      case 'UNT':
        if (!openMessage) {
          addIssue(issues, {
            code: 'edifact-unt-without-unh',
            message: 'UNT segment encountered without an open UNH message',
            segmentTag: 'UNT',
            segmentIndex: index,
          });
          break;
        }

        if (readString(segment.elements[1]) !== openMessage.controlNumber) {
          addIssue(issues, {
            code: 'edifact-message-control',
            message: 'UNH1 must match UNT2',
            segmentTag: 'UNT',
            segmentIndex: index,
          });
        }

        if (
          Number(readString(segment.elements[0])) !== openMessage.countedSegments
        ) {
          addIssue(issues, {
            code: 'edifact-segment-count',
            message: 'UNT1 must equal the number of segments between UNH and UNT',
            segmentTag: 'UNT',
            segmentIndex: index,
          });
        }

        messageCount++;
        openMessage = undefined;
        break;
      case 'UNZ':
        if (Number(readString(segment.elements[0]) ?? '0') !== messageCount) {
          addIssue(issues, {
            code: 'edifact-message-count',
            message: 'UNZ1 must equal the number of UNH/UNT messages',
            segmentTag: 'UNZ',
            segmentIndex: index,
          });
        }
        break;
      default:
        break;
    }
  });

  if (openMessage) {
    addIssue(issues, {
      code: 'edifact-open-message',
      message: 'Encountered a UNH without a matching UNT',
      segmentTag: 'UNH',
      segmentIndex: openMessage.startIndex,
    });
  }

  return {
    standard: 'edifact',
    valid: issues.every((issue) => issue.severity !== 'error'),
    issues,
  };
}

export function detectEdifactAcknowledgment(
  document: EdiDocument
): AcknowledgmentInfo | null {
  assertEdifactDocument(document);
  const header = document.segments.find((segment) => segment.tag === 'UNH');
  const messageType = Array.isArray(header?.elements[1])
    ? header.elements[1][0]
    : undefined;

  if (messageType !== 'CONTRL') {
    return null;
  }

  return {
    standard: 'edifact',
    type: 'CONTRL',
    controlNumber: readString(header?.elements[0]),
  };
}
