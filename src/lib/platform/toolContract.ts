// Transport-neutral tool contract (MCP plan W1a) — the shape of a tool
// definition with no SDK dependency, so the registry in
// services/platform/assistant/tools.ts can be consumed by any transport:
// the Anthropic Messages API today (adapted inside lib/claude.ts, the only
// conversion point) and the planned MCP server (which maps input_schema to
// MCP's inputSchema). `input_schema` is plain JSON Schema and keeps the
// Anthropic wire-field name so the model-API adaptation is a field-for-field
// copy, not a rename.

export interface ToolInputSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolContract {
  name: string;
  description?: string;
  input_schema: ToolInputSchema;
}
