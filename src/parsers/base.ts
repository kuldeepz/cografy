import type { ParseResult } from "../types.js";

export interface LanguageParser {
  /** Languages this parser can handle, or "*" for any. */
  languages: string[] | "*";
  parse(filePath: string, source: string, language: string): ParseResult;
}
