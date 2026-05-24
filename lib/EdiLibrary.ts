import { mapEdiToJson, mapJsonToEdiSegments } from './EdiMapping.js';
import {
  detectEdifactAcknowledgment,
  generateEdifact,
  parseEdifact,
  validateEdifact,
} from './Edifact.js';
import type {
  EdiAdapter,
  EdiDocument,
  EdiStandard,
  EdiToJsonRule,
  JsonToEdiRule,
} from './EdiTypes.js';
import {
  detectX12Acknowledgment,
  generateX12,
  parseX12,
  validateX12,
} from './X12.js';

export const x12Adapter: EdiAdapter = {
  standard: 'x12',
  parse: parseX12,
  generate: generateX12,
  validate: validateX12,
  detectAcknowledgment: detectX12Acknowledgment,
};

export const edifactAdapter: EdiAdapter = {
  standard: 'edifact',
  parse: parseEdifact,
  generate: generateEdifact,
  validate: validateEdifact,
  detectAcknowledgment: detectEdifactAcknowledgment,
};

export class EdiLibrary {
  #adapters: Map<EdiStandard, EdiAdapter>;

  constructor(adapters: EdiAdapter[] = [x12Adapter, edifactAdapter]) {
    this.#adapters = new Map();
    adapters.forEach((adapter) => this.registerAdapter(adapter));
  }

  registerAdapter(adapter: EdiAdapter): void {
    this.#adapters.set(adapter.standard, adapter);
  }

  supportedStandards(): EdiStandard[] {
    return [...this.#adapters.keys()];
  }

  parse(input: string, standard: EdiStandard): EdiDocument {
    const adapter = this.#adapters.get(standard);
    if (!adapter) {
      throw new Error(`No EDI adapter registered for ${standard}`);
    }

    return adapter.parse(input);
  }

  generate(document: EdiDocument): string {
    const adapter = this.#adapters.get(document.standard);
    if (!adapter) {
      throw new Error(`No EDI adapter registered for ${document.standard}`);
    }

    return adapter.generate(document);
  }

  validate(document: EdiDocument) {
    const adapter = this.#adapters.get(document.standard);
    if (!adapter) {
      throw new Error(`No EDI adapter registered for ${document.standard}`);
    }

    return adapter.validate(document);
  }

  detectAcknowledgment(document: EdiDocument) {
    const adapter = this.#adapters.get(document.standard);
    if (!adapter) {
      throw new Error(`No EDI adapter registered for ${document.standard}`);
    }

    return adapter.detectAcknowledgment(document);
  }

  mapJsonToEdi(
    payload: unknown,
    rules: JsonToEdiRule[],
    document: EdiDocument
  ): EdiDocument {
    return {
      ...document,
      segments: mapJsonToEdiSegments(payload, rules, document.segments),
    };
  }

  mapEdiToJson(document: EdiDocument, rules: EdiToJsonRule[]) {
    return mapEdiToJson(document, rules);
  }
}
