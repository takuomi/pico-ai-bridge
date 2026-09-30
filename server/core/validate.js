/** Validate the JSON Schema subset used by this tool registry. Returns human-readable errors. */
export function validate(schema, value, path = 'arguments') {
  const errors = [];
  if (schema.type) {
    const types = [schema.type].flat();
    if (!types.some(type => matchesType(type, value))) return [`${path} must be ${types.map(typeName).join(' or ')}`];
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} must be one of ${schema.enum.join(', ')}`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} must be at most ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} needs at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path} allows at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, index) => errors.push(...validate(schema.items, item, `${path}[${index}]`)));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`);
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) errors.push(...validate(schema.properties[key], item, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not allowed`);
    }
  }
  return errors;
}

function matchesType(type, value) {
  return type === 'array' ? Array.isArray(value)
    : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : type === 'null' ? value === null
    : type === 'integer' ? Number.isSafeInteger(value)
    : type === 'number' ? Number.isFinite(value)
    : typeof value === type;
}

function typeName(type) {
  return type === 'number' ? 'a finite number' : type === 'integer' ? 'a safe integer' : type;
}

/** Find numbers that JSON parsing cannot preserve or stringify as intended. */
export function nonFiniteNumbers(value, path = 'arguments') {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return [`${path} must be a finite number`];
    return Number.isInteger(value) && !Number.isSafeInteger(value) ? [`${path} must be a safe integer or a non-integral number`] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item, index) => nonFiniteNumbers(item, `${path}[${index}]`));
  if (value !== null && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => nonFiniteNumbers(item, `${path}.${key}`));
  return [];
}
