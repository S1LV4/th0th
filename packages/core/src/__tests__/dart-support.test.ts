import { describe, expect, test } from "bun:test";
import { CodeCompressor } from "../services/compression/code-compressor.js";
import { smartChunk } from "../services/search/smart-chunker.js";

describe("Dart support", () => {
  test("smart chunker treats .dart files as code", () => {
    const dartCode = `import 'package:flutter/widgets.dart';

class Counter {
  int value = 0;

  void increment() {
    value++;
  }
}
`;

    const chunks = smartChunk(dartCode, "lib/counter.dart");

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.type === "code_block")).toBe(true);
  });

  test("code compressor detects dart language", async () => {
    const compressor = new CodeCompressor();
    const dartCode = `import 'dart:convert';

class User {
  final String name;
  User(this.name);
}
`;

    const compressed = await compressor.compress(dartCode);

    expect(compressed.metadata.language).toBe("dart");
  });
});
