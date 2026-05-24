import { describe, expect, it } from 'vitest';

import {
  EdiLibrary,
  detectEdifactAcknowledgment,
  detectX12Acknowledgment,
  generateEdifact,
  generateX12,
  mapEdiToJson,
  mapJsonToEdiSegments,
  parseEdifact,
  parseX12,
  parseX12Formatted,
  validateEdifact,
  validateX12,
} from '@/index.js';
import type { EdiAdapter, EdiDocument } from '@/index.js';

const validX12 =
  'ISA*00*          *00*          *ZZ*EMEDNYBAT      *ZZ*ETIN           *100101*1000*^*00501*006000600*0*T*:~GS*HP*EMEDNYBAT*ETIN*20100101*1050*6000600*X*005010X221A1~ST*850*0001~REF*PO*1:2~SE*3*0001~GE*1*6000600~IEA*1*006000600~';

const ackX12 =
  'ISA*00*          *00*          *ZZ*EMEDNYBAT      *ZZ*ETIN           *100101*1000*^*00501*006000600*0*T*:~GS*FA*EMEDNYBAT*ETIN*20100101*1050*6000600*X*005010X231A1~ST*997*0001~AK1*PO*1~SE*3*0001~GE*1*6000600~IEA*1*006000600~';

const validEdifact =
  "UNA:+.? 'UNB+UNOC:3+SENDER:14+RECEIVER:14+240101:1200+1'UNH+1+ORDERS:D:96A:UN'BGM+220+PO123+9'UNT+3+1'UNZ+1+1'";

const contrlEdifact =
  "UNB+UNOC:3+SENDER:14+RECEIVER:14+240101:1200+1'UNH+1+CONTRL:D:96A:UN'UCI+1+SENDER+RECEIVER'UNT+3+1'UNZ+1+1'";

describe('EDI library surface', () => {
  describe('X12 helpers', () => {
    it('parses, formats, generates, validates, and detects acknowledgments', () => {
      const document = parseX12(validX12);
      const formatted = parseX12Formatted(validX12);

      expect(document.standard).toBe('x12');
      expect(document.envelope.transactionType).toBe('850');
      expect(document.envelope.groupControlNumber).toBe('6000600');
      expect(document.segments[3]).toStrictEqual({
        tag: 'REF',
        elements: ['PO', ['1', '2']],
      });
      expect(formatted[3]).toStrictEqual({
        '1': 'PO',
        '2': '1',
        '2-1': '2',
        name: 'REF',
      });
      expect(generateX12(document)).toBe(validX12);
      expect(validateX12(document)).toStrictEqual({
        standard: 'x12',
        valid: true,
        issues: [],
      });
      expect(detectX12Acknowledgment(document)).toBeNull();
      expect(detectX12Acknowledgment(parseX12(ackX12))).toStrictEqual({
        standard: 'x12',
        type: '997',
        controlNumber: '0001',
      });
    });

    it('reports structural X12 issues and rejects non-X12 documents', () => {
      const invalid = parseX12(
        validX12
          .replace('SE*3*0001~', 'SE*4*9999~')
          .replace('GE*1*6000600~', 'GE*2*1111~')
          .replace('IEA*1*006000600~', 'IEA*2*000000000~')
      );
      const issues = validateX12(invalid).issues.map((issue) => issue.code);

      expect(issues).toContain('x12-transaction-control');
      expect(issues).toContain('x12-segment-count');
      expect(issues).toContain('x12-group-count');
      expect(issues).toContain('x12-group-control');
      expect(issues).toContain('x12-interchange-control');
      expect(issues).toContain('x12-interchange-count');

      const danglingGroup = {
        ...parseX12(validX12),
        segments: parseX12(validX12).segments.slice(0, -2),
      };
      expect(validateX12(danglingGroup).issues.map((issue) => issue.code)).toContain(
        'x12-open-group'
      );

      expect(() =>
        generateX12({
          ...parseEdifact(contrlEdifact),
        })
      ).toThrow('Expected an X12 document');
    });

    it('handles SE without ST and open transactions', () => {
      const seWithoutSt: EdiDocument = {
        standard: 'x12',
        syntax: parseX12(validX12).syntax,
        envelope: {},
        segments: [
          { tag: 'ISA', elements: [] },
          { tag: 'GS', elements: ['', '', '', '', '', '1'] },
          { tag: 'SE', elements: ['2', '1'] },
          { tag: 'IEA', elements: ['1', ''] },
        ],
      };
      const openTransaction: EdiDocument = {
        standard: 'x12',
        syntax: parseX12(validX12).syntax,
        envelope: {},
        segments: [
          { tag: 'ISA', elements: [] },
          { tag: 'GS', elements: ['', '', '', '', '', '1'] },
          { tag: 'ST', elements: ['850', '1'] },
          { tag: 'BEG', elements: ['00'] },
          { tag: 'IEA', elements: ['1', ''] },
        ],
      };

      expect(
        validateX12(seWithoutSt).issues.map((issue) => issue.code)
      ).toContain('x12-se-without-st');
      expect(
        validateX12(openTransaction).issues.map((issue) => issue.code)
      ).toContain('x12-open-transaction');

      const badEnvelope: EdiDocument = {
        standard: 'x12',
        syntax: parseX12(validX12).syntax,
        envelope: {},
        segments: [{ tag: 'GS', elements: [] }, { tag: 'GE', elements: [] }],
      };

      expect(
        validateX12(badEnvelope).issues.map((issue) => issue.code)
      ).toContain('x12-envelope-start');
      expect(
        validateX12(badEnvelope).issues.map((issue) => issue.code)
      ).toContain('x12-envelope-end');

      const missingIeaCount: EdiDocument = {
        standard: 'x12',
        syntax: parseX12(validX12).syntax,
        envelope: {},
        segments: [
          { tag: 'ISA', elements: [] },
          { tag: 'GS', elements: ['', '', '', '', '', '1'] },
          { tag: 'GE', elements: ['0', '1'] },
          { tag: 'IEA', elements: [] },
        ],
      };
      expect(
        validateX12(missingIeaCount).issues.map((issue) => issue.code)
      ).toContain('x12-interchange-count');
    });

    it('falls back to default X12 syntax when delimiters are incomplete', () => {
      const document = parseX12('ISA');

      expect(document.syntax).toStrictEqual({
        segmentTerminator: '\n',
        elementSeparator: '*',
        componentSeparator: ':',
        repetitionSeparator: '^',
      });
      expect(document.envelope).toStrictEqual({
        senderId: undefined,
        receiverId: undefined,
        version: undefined,
        transactionType: undefined,
        interchangeControlNumber: undefined,
        groupControlNumber: undefined,
        transactionControlNumber: undefined,
      });
      expect(parseX12Formatted('ISA')).toStrictEqual([{ name: 'ISA' }]);
    });
  });

  describe('EDIFACT helpers', () => {
    it('parses, generates, validates, escapes values, and detects acknowledgments', () => {
      const document = parseEdifact(validEdifact);
      const noUnaDocument = parseEdifact(contrlEdifact);
      const escaped = generateEdifact({
        standard: 'edifact',
        syntax: document.syntax,
        envelope: {},
        includeSyntaxSegment: false,
        segments: [{ tag: 'FTX', elements: ['A+B', "C'D"] }],
      });

      expect(document.standard).toBe('edifact');
      expect(document.includeSyntaxSegment).toBe(true);
      expect(document.envelope.transactionType).toBe('ORDERS');
      expect(document.segments[1]).toStrictEqual({
        tag: 'UNH',
        elements: ['1', ['ORDERS', 'D', '96A', 'UN']],
      });
      expect(generateEdifact(document)).toBe(validEdifact);
      expect(validateEdifact(document)).toStrictEqual({
        standard: 'edifact',
        valid: true,
        issues: [],
      });
      expect(detectEdifactAcknowledgment(document)).toBeNull();
      expect(detectEdifactAcknowledgment(noUnaDocument)).toStrictEqual({
        standard: 'edifact',
        type: 'CONTRL',
        controlNumber: '1',
      });
      expect(escaped).toBe("FTX+A?+B+C?'D'");
      expect(noUnaDocument.includeSyntaxSegment).toBe(false);
    });

    it('reports structural EDIFACT issues and rejects non-EDIFACT documents', () => {
      const invalid = parseEdifact(contrlEdifact.replace("UNZ+1+1'", "UNZ+2+9'"));
      const issues = validateEdifact(invalid).issues.map((issue) => issue.code);

      expect(issues).toContain('edifact-interchange-control');
      expect(issues).toContain('edifact-message-count');

      const untWithoutUnh: EdiDocument = {
        standard: 'edifact',
        syntax: parseEdifact(contrlEdifact).syntax,
        envelope: {},
        segments: [
          { tag: 'UNB', elements: [] },
          { tag: 'UNT', elements: ['1', '1'] },
          { tag: 'UNZ', elements: ['0', ''] },
        ],
      };
      const openMessage: EdiDocument = {
        standard: 'edifact',
        syntax: parseEdifact(contrlEdifact).syntax,
        envelope: {},
        segments: [
          { tag: 'UNB', elements: [] },
          { tag: 'UNH', elements: ['1', ['ORDERS', 'D', '96A', 'UN']] },
          { tag: 'BGM', elements: ['220'] },
          { tag: 'UNZ', elements: ['0', ''] },
        ],
      };

      expect(
        validateEdifact(untWithoutUnh).issues.map((issue) => issue.code)
      ).toContain('edifact-unt-without-unh');
      expect(
        validateEdifact(openMessage).issues.map((issue) => issue.code)
      ).toContain('edifact-open-message');
      expect(
        validateEdifact({
          standard: 'edifact',
          syntax: parseEdifact(contrlEdifact).syntax,
          envelope: {},
          segments: [
            { tag: 'UNB', elements: [] },
            { tag: 'UNH', elements: ['1', ['ORDERS', 'D', '96A', 'UN']] },
            { tag: 'UNT', elements: ['2', '1'] },
            { tag: 'UNZ', elements: [] },
          ],
        }).issues.map((issue) => issue.code)
      ).toContain('edifact-message-count');
      expect(
        validateEdifact(parseEdifact("BGM+220+PO123+9'UNT+2+1'")).issues.map(
          (issue) => issue.code
        )
      ).toContain('edifact-envelope-start');
      expect(
        validateEdifact(parseEdifact("BGM+220+PO123+9'UNT+2+1'")).issues.map(
          (issue) => issue.code
        )
      ).toContain('edifact-envelope-end');
      expect(
        validateEdifact(
          parseEdifact(contrlEdifact.replace("UNT+3+1'", "UNT+4+9'"))
        ).issues.map((issue) => issue.code)
      ).toContain('edifact-message-control');
      expect(
        validateEdifact(
          parseEdifact(contrlEdifact.replace("UNT+3+1'", "UNT+4+9'"))
        ).issues.map((issue) => issue.code)
      ).toContain('edifact-segment-count');
      expect(
        detectEdifactAcknowledgment({
          standard: 'edifact',
          syntax: parseEdifact(contrlEdifact).syntax,
          envelope: {},
          segments: [{ tag: 'UNH', elements: ['1', 'CONTRL'] }],
        })
      ).toBeNull();
      expect(() => generateEdifact(parseX12(validX12))).toThrow(
        'Expected an EDIFACT document'
      );
    });

    it('parses escaped EDIFACT values and handles partial envelopes', () => {
      const parsed = parseEdifact(
        "UNB+UNOC:3'UNH+1+ORDERS:D:96A:UN'FTX+A?+B+C??D'UNT+3+1'UNZ+1'"
      );

      expect(parsed.segments[2]).toStrictEqual({
        tag: 'FTX',
        elements: ['A+B', 'C?D'],
      });
      expect(parsed.envelope.receiverId).toBeUndefined();
      expect(parsed.envelope.interchangeControlNumber).toBeUndefined();
    });
  });

  describe('Mapping and orchestration', () => {
    it('maps JSON to EDI segments and back', () => {
      const mappedSegments = mapJsonToEdiSegments(
        {
          order: {
            number: 123,
            line: {
              code: 'ABC',
            },
          },
        },
        [
          { from: 'order.number', segment: 'BEG', element: 3 },
          {
            from: 'order.line.code',
            segment: 'REF',
            element: 2,
            component: 2,
          },
          {
            from: 'order.line.primary',
            segment: 'REF',
            element: 2,
            component: 1,
            defaultValue: 'ROOT',
          },
          {
            from: 'order.optional',
            segment: 'N9',
            element: 1,
            defaultValue: 'DEFAULT',
          },
          {
            from: 'order.line.tail',
            segment: 'REF',
            element: 2,
            component: 3,
            defaultValue: 'TAIL',
          },
          {
            from: 'order.skipMe',
            segment: 'SKP',
            element: 1,
          },
        ],
        [{ tag: 'REF', elements: ['PO', ''] }]
      );

      const document: EdiDocument = {
        standard: 'x12',
        syntax: parseX12(validX12).syntax,
        envelope: {},
        segments: mappedSegments,
      };

      expect(mappedSegments).toStrictEqual([
        { tag: 'REF', elements: ['PO', ['ROOT', 'ABC', 'TAIL']] },
        { tag: 'BEG', elements: ['', '', '123'] },
        { tag: 'N9', elements: ['DEFAULT'] },
      ]);
      expect(
        mapEdiToJson(document, [
          {
            to: 'order.number',
            segment: 'BEG',
            element: 3,
            transform: (value) => Number(value),
          },
          {
            to: 'order.line.code',
            segment: 'REF',
            element: 2,
            component: 2,
          },
          {
            to: 'order.line.flat',
            segment: 'REF',
            element: 2,
          },
          {
            to: '',
            segment: 'REF',
            element: 1,
          },
        ])
      ).toStrictEqual({
        order: {
          number: 123,
          line: {
            code: 'ABC',
            flat: 'ROOT:ABC:TAIL',
          },
        },
      });
    });

    it('preserves seed arrays, uses transforms, and returns undefined for missing values', () => {
      const seed = [{ tag: 'REF', elements: [['LEGACY'], 'PO'] }];
      const mapped = mapJsonToEdiSegments(
        { order: { id: 7 } },
        [
          {
            from: 'order.id',
            segment: 'REF',
            element: 2,
            component: 2,
            transform: (value) => `ID-${value}`,
          },
        ],
        seed
      );

      expect(seed).toStrictEqual([{ tag: 'REF', elements: [['LEGACY'], 'PO'] }]);
      expect(mapped).toStrictEqual([
        { tag: 'REF', elements: [['LEGACY'], ['PO', 'ID-7']] },
      ]);
      expect(
        mapEdiToJson(
          {
            standard: 'x12',
            syntax: parseX12(validX12).syntax,
            envelope: {},
            segments: mapped,
          },
          [{ to: 'missing.value', segment: 'BEG', element: 1 }]
        )
      ).toStrictEqual({
        missing: {
          value: undefined,
        },
      });
    });

    it('orchestrates adapters through the EdiLibrary facade', () => {
      const library = new EdiLibrary();
      const document = library.parse(validX12, 'x12');
      const customAdapter: EdiAdapter = {
        standard: 'x12',
        parse: () => document,
        generate: () => 'custom',
        validate: () => ({ standard: 'x12', valid: true, issues: [] }),
        detectAcknowledgment: () => null,
      };

      expect(library.supportedStandards().sort()).toStrictEqual([
        'edifact',
        'x12',
      ]);
      expect(library.generate(document)).toBe(validX12);
      expect(library.validate(document).valid).toBe(true);
      expect(library.detectAcknowledgment(library.parse(ackX12, 'x12'))).toStrictEqual(
        {
          standard: 'x12',
          type: '997',
          controlNumber: '0001',
        }
      );
      expect(
        library.mapJsonToEdi(
          { order: { id: 'PO-1' } },
          [{ from: 'order.id', segment: 'BEG', element: 3 }],
          {
            ...document,
            segments: [],
          }
        ).segments
      ).toStrictEqual([{ tag: 'BEG', elements: ['', '', 'PO-1'] }]);
      expect(
        library.mapEdiToJson(document, [
          { to: 'transaction.type', segment: 'ST', element: 1 },
        ])
      ).toStrictEqual({
        transaction: {
          type: '850',
        },
      });

      library.registerAdapter(customAdapter);
      expect(library.generate(document)).toBe('custom');
      const emptyLibrary = new EdiLibrary([]);
      expect(() => emptyLibrary.parse(validX12, 'x12')).toThrow(
        'No EDI adapter registered for x12'
      );
      expect(() => emptyLibrary.generate(document)).toThrow(
        'No EDI adapter registered for x12'
      );
      expect(() => emptyLibrary.validate(document)).toThrow(
        'No EDI adapter registered for x12'
      );
      expect(() => emptyLibrary.detectAcknowledgment(document)).toThrow(
        'No EDI adapter registered for x12'
      );
    });
  });
});
