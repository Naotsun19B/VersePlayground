// Copyright (c) 2026 Naotsun

/**
 * Module path qualifier that verse.exe puts in front of names, such as "(/user@localhost/point:)" in
 * "(/user@localhost/point:)X" or "(/user@localhost:)" in "(/user@localhost:)point{X := 4}". It starts with "(/" and
 * ends with ":)".
 */
const MODULE_QUALIFIER_PATTERN = /\(\/[^()\s"']*:\)/g;

/** One variable as verse.exe reports it. Fields other than the name and the value pass through unchanged. */
export interface ServerVariable {
  /** Name of the variable, field or element. */
  name: string;

  /** The value as Verse source text. */
  value: string;

  /** Other fields, such as variablesReference. */
  [field: string]: unknown;
}

/**
 * Removes the module path qualifiers from the names and values of variables, so that a field shows as "X" instead of
 * "(/user@localhost/point:)X". Strings and characters are left alone, since their text is the program's data.
 */
export function toClientVariables(serverBody: Record<string, unknown>): { variables: ServerVariable[] } {
  const serverVariables = (Array.isArray(serverBody.variables) ? serverBody.variables : []) as ServerVariable[];
  return {
    variables: serverVariables.map((serverVariable) => ({
      ...serverVariable,
      name: removeModuleQualifiers(serverVariable.name),
      value: (isTextValue(serverVariable.value) ? serverVariable.value : removeModuleQualifiers(serverVariable.value)),
    })),
  };
}

/** Removes every module path qualifier from the text. */
function removeModuleQualifiers(text: string): string {
  return text.replace(MODULE_QUALIFIER_PATTERN, '');
}

/** Returns whether the value is a string or a character, which verse.exe shows in quotes. */
function isTextValue(value: string): boolean {
  return value.startsWith('"') || value.startsWith('\'');
}
