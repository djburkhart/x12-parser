export type EdiStandard = 'x12' | 'edifact';
export type EdiProtocol = 'as2' | 'sftp' | 'ftps' | 'ftp' | 'van' | 'api';
export type EdiElement = string | string[];
export type ValidationSeverity = 'error' | 'warning';

export interface EdiSyntax {
  segmentTerminator: string;
  elementSeparator: string;
  componentSeparator: string;
  repetitionSeparator?: string;
  decimalMark?: string;
  releaseCharacter?: string;
}

export interface EdiSegment {
  tag: string;
  elements: EdiElement[];
}

export interface EdiEnvelope {
  senderId?: string;
  receiverId?: string;
  version?: string;
  transactionType?: string;
  interchangeControlNumber?: string;
  groupControlNumber?: string;
  transactionControlNumber?: string;
}

export interface EdiDocument {
  standard: EdiStandard;
  syntax: EdiSyntax;
  segments: EdiSegment[];
  envelope: EdiEnvelope;
  includeSyntaxSegment?: boolean;
}

export interface ValidationIssue {
  code: string;
  message: string;
  severity: ValidationSeverity;
  segmentTag?: string;
  segmentIndex?: number;
}

export interface ValidationReport {
  standard: EdiStandard;
  valid: boolean;
  issues: ValidationIssue[];
}

export interface AcknowledgmentInfo {
  standard: EdiStandard;
  type: '997' | '999' | 'CONTRL';
  controlNumber?: string;
}

export interface JsonToEdiRule {
  from: string;
  segment: string;
  element: number;
  component?: number;
  occurrence?: number;
  defaultValue?: string;
  transform?: (value: unknown) => string | undefined;
}

export interface EdiToJsonRule {
  to: string;
  segment: string;
  element: number;
  component?: number;
  occurrence?: number;
  transform?: (value: string | undefined) => unknown;
}

export interface TradingPartnerCertificate {
  id: string;
  purpose: 'signing' | 'encryption' | 'tls';
  fingerprint?: string;
  expiresAt?: string;
}

export interface TradingPartnerProfile {
  id: string;
  name: string;
  standards: EdiStandard[];
  protocols: EdiProtocol[];
  senderId?: string;
  receiverId?: string;
  acknowledgments?: Partial<Record<EdiStandard, '997' | '999' | 'CONTRL'>>;
  certificates?: TradingPartnerCertificate[];
  metadata?: Record<string, string>;
}

export interface OutboundEdiMessage {
  partnerId: string;
  document: EdiDocument;
  payload: string;
  filename?: string;
  correlationId?: string;
}

export interface TransportReceipt {
  protocol: EdiProtocol;
  messageId: string;
  status: 'queued' | 'sent' | 'received' | 'failed';
  timestamp: string;
}

export interface EdiTransportAdapter {
  protocol: EdiProtocol;
  send(
    message: OutboundEdiMessage,
    partner: TradingPartnerProfile
  ): Promise<TransportReceipt>;
}

export interface EdiAuditEvent {
  type:
    | 'received'
    | 'parsed'
    | 'validated'
    | 'mapped'
    | 'generated'
    | 'sent'
    | 'acknowledged'
    | 'failed';
  partnerId?: string;
  standard?: EdiStandard;
  transactionType?: string;
  message: string;
  timestamp: string;
  metadata?: Record<string, string>;
}

export interface EdiAuditLogger {
  log(event: EdiAuditEvent): void | Promise<void>;
}

export interface EdiIntegrationRecord {
  documentId: string;
  entity: 'order' | 'shipment' | 'inventory' | 'invoice' | 'custom';
  direction: 'inbound' | 'outbound';
  payload: unknown;
  partnerId?: string;
}

export interface EdiAdapter {
  standard: EdiStandard;
  parse(input: string): EdiDocument;
  generate(document: EdiDocument): string;
  validate(document: EdiDocument): ValidationReport;
  detectAcknowledgment(document: EdiDocument): AcknowledgmentInfo | null;
}
