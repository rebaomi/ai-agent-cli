export interface ToolSchemaValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateToolArgsAgainstSchema(schema: Record<string, unknown> | undefined, args: Record<string, unknown>): ToolSchemaValidationResult {
  if (!schema || typeof schema !== 'object') {
    return { valid: true, errors: [] };
  }

  const errors: string[] = [];
  validateSchemaNode(schema, args, '$', errors);
  return {
    valid: errors.length === 0,
    errors,
  };
}

function validateSchemaNode(schema: unknown, value: unknown, path: string, errors: string[]): void {
  if (!schema || typeof schema !== 'object') {
    return;
  }

  const node = schema as Record<string, unknown>;

  if (Array.isArray(node.anyOf) && node.anyOf.length > 0) {
    if (!matchesComposite(node.anyOf, value, path)) {
      errors.push(`${path} does not match any allowed schema variant`);
    }
    return;
  }

  if (Array.isArray(node.oneOf) && node.oneOf.length > 0) {
    if (!matchesComposite(node.oneOf, value, path)) {
      errors.push(`${path} does not match any allowed schema variant`);
    }
    return;
  }

  if (Array.isArray(node.enum) && !node.enum.some((candidate) => isDeepEqual(candidate, value))) {
    errors.push(`${path} must be one of: ${node.enum.map(item => JSON.stringify(item)).join(', ')}`);
    return;
  }

  const declaredTypes = normalizeSchemaTypes(node.type, node.properties, node.items);
  if (declaredTypes.length > 0 && !declaredTypes.some((type) => matchesType(type, value))) {
    errors.push(`${path} expected ${declaredTypes.join(' | ')}, got ${describeValueType(value)}`);
    return;
  }

  if (value === undefined || value === null) {
    return;
  }

  if (declaredTypes.includes('object') && isPlainObject(value)) {
    validateObjectNode(node, value, path, errors);
    return;
  }

  if (declaredTypes.includes('array') && Array.isArray(value)) {
    validateArrayNode(node, value, path, errors);
    return;
  }
}

function validateObjectNode(schema: Record<string, unknown>, value: Record<string, unknown>, path: string, errors: string[]): void {
  const properties = isPlainObject(schema.properties) ? schema.properties as Record<string, unknown> : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : [];
  const additionalProperties = schema.additionalProperties;

  for (const key of required) {
    if (!(key in value) || value[key] === undefined) {
      errors.push(`${path}.${key} is required`);
    }
  }

  for (const [key, childValue] of Object.entries(value)) {
    const childSchema = properties[key];
    if (childSchema) {
      validateSchemaNode(childSchema, childValue, `${path}.${key}`, errors);
      continue;
    }

    if (additionalProperties === true || additionalProperties === undefined && Object.keys(properties).length === 0) {
      continue;
    }

    if (isPlainObject(additionalProperties)) {
      validateSchemaNode(additionalProperties, childValue, `${path}.${key}`, errors);
      continue;
    }

    errors.push(`${path}.${key} is not allowed`);
  }
}

function validateArrayNode(schema: Record<string, unknown>, value: unknown[], path: string, errors: string[]): void {
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
    errors.push(`${path} requires at least ${schema.minItems} item(s)`);
  }

  if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
    errors.push(`${path} allows at most ${schema.maxItems} item(s)`);
  }

  const itemSchema = schema.items;
  if (!itemSchema) {
    return;
  }

  value.forEach((item, index) => {
    validateSchemaNode(itemSchema, item, `${path}[${index}]`, errors);
  });
}

function normalizeSchemaTypes(typeValue: unknown, properties: unknown, items: unknown): string[] {
  if (Array.isArray(typeValue)) {
    return typeValue.filter((item): item is string => typeof item === 'string');
  }

  if (typeof typeValue === 'string') {
    return [typeValue];
  }

  if (isPlainObject(properties)) {
    return ['object'];
  }

  if (items) {
    return ['array'];
  }

  return [];
}

function matchesComposite(options: unknown[], value: unknown, path: string): boolean {
  return options.some((option) => validateSubschema(option, value, path));
}

function validateSubschema(schema: unknown, value: unknown, path: string): boolean {
  const errors: string[] = [];
  validateSchemaNode(schema, value, path, errors);
  return errors.length === 0;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function describeValueType(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return 'array';
  }

  return typeof value;
}

function isDeepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}