import type {
  EdiDocument,
  EdiElement,
  EdiSegment,
  EdiToJsonRule,
  JsonToEdiRule,
} from './EdiTypes.js';

function getPathValue(source: unknown, path: string): unknown {
  return path
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((current, key) => {
      if (current && typeof current === 'object' && key in current) {
        return (current as Record<string, unknown>)[key];
      }

      return undefined;
    }, source);
}

function setPathValue(target: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split('.').filter(Boolean);

  if (keys.length === 0) {
    return;
  }

  let current: Record<string, unknown> = target;
  keys.forEach((key, index) => {
    if (index === keys.length - 1) {
      current[key] = value;
      return;
    }

    const next = current[key];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      current[key] = {};
    }

    current = current[key] as Record<string, unknown>;
  });
}

function cloneSegments(segments: EdiSegment[]): EdiSegment[] {
  return segments.map((segment) => ({
    tag: segment.tag,
    elements: segment.elements.map((element) =>
      Array.isArray(element) ? [...element] : element
    ),
  }));
}

function ensureElement(
  segment: EdiSegment,
  elementIndex: number,
  componentIndex?: number
): EdiElement[] | string[] {
  while (segment.elements.length < elementIndex) {
    segment.elements.push('');
  }

  const current = segment.elements[elementIndex - 1];
  if (componentIndex) {
    if (Array.isArray(current)) {
      while (current.length < componentIndex) {
        current.push('');
      }
      return current;
    }

    const next = current === '' ? [] : [String(current)];
    while (next.length < componentIndex) {
      next.push('');
    }
    segment.elements[elementIndex - 1] = next;
    return next;
  }

  return segment.elements;
}

function findOrCreateSegment(
  segments: EdiSegment[],
  tag: string,
  occurrence = 0
): EdiSegment {
  const matches = segments.filter((segment) => segment.tag === tag);
  while (matches.length <= occurrence) {
    const created = { tag, elements: [] as EdiElement[] };
    segments.push(created);
    matches.push(created);
  }

  return matches[occurrence];
}

function normalizeMappedValue(
  value: unknown,
  rule: JsonToEdiRule
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return rule.defaultValue;
  }

  return rule.transform ? rule.transform(value) : String(value);
}

export function mapJsonToEdiSegments(
  payload: unknown,
  rules: JsonToEdiRule[],
  seedSegments: EdiSegment[] = []
): EdiSegment[] {
  const segments = cloneSegments(seedSegments);

  rules.forEach((rule) => {
    const rawValue = getPathValue(payload, rule.from);
    const mappedValue = normalizeMappedValue(rawValue, rule);

    if (mappedValue === undefined) {
      return;
    }

    const segment = findOrCreateSegment(segments, rule.segment, rule.occurrence);
    if (rule.component) {
      const components = ensureElement(segment, rule.element, rule.component);
      components[rule.component - 1] = mappedValue;
      return;
    }

    ensureElement(segment, rule.element);
    segment.elements[rule.element - 1] = mappedValue;
  });

  return segments;
}

function getElementValue(
  document: EdiDocument,
  rule: EdiToJsonRule
): string | undefined {
  const segment = document.segments.filter((item) => item.tag === rule.segment)[
    rule.occurrence ?? 0
  ];
  const value = segment?.elements[rule.element - 1];

  if (Array.isArray(value)) {
    if (rule.component) {
      return value[rule.component - 1];
    }

    return value.join(document.syntax.componentSeparator);
  }

  return typeof value === 'string' ? value : undefined;
}

export function mapEdiToJson(
  document: EdiDocument,
  rules: EdiToJsonRule[]
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  rules.forEach((rule) => {
    const value = getElementValue(document, rule);
    setPathValue(result, rule.to, rule.transform ? rule.transform(value) : value);
  });

  return result;
}
