import { describe, expect, it } from 'vitest';
import { parseWrittenCalls, TextCallScanner } from './text-calls';

/** Feed `deltas` through a scanner: what was said, and what was held back as calls. */
function scan(deltas: readonly string[]) {
  const scanner = new TextCallScanner();
  let said = deltas.map((delta) => scanner.feed(delta)).join('');
  const rest = scanner.end();
  said += rest.text;
  return { said, calls: rest.calls };
}

describe('written tool calls (R-29)', () => {
  it('reads the two shapes Gemma 4 31b wrote, with Windows paths either way', () => {
    expect(parseWrittenCalls('[tool:files__read_text_file(path="C:\\\\Users\\\\rickm\\\\Documents\\\\herbal-teas.txt")]')).toEqual([
      { name: 'files__read_text_file', arguments: { path: 'C:\\Users\\rickm\\Documents\\herbal-teas.txt' } },
    ]);
    expect(parseWrittenCalls('<call:files__read_text_file path="C:\\Users\\rickm\\Documents\\herbal-teas.txt"/>')).toEqual([
      { name: 'files__read_text_file', arguments: { path: 'C:\\Users\\rickm\\Documents\\herbal-teas.txt' } },
    ]);
  });

  it("reads Gemma's own syntax, with its string quote, and a path whose backslashes look like escapes", () => {
    expect(parseWrittenCalls('[tool_call:files__read_text_file{path:<|"|>C:\\Users\\rickm\\Documents\\herbal-teas.txt<|"|>}]')).toEqual([
      { name: 'files__read_text_file', arguments: { path: 'C:\\Users\\rickm\\Documents\\herbal-teas.txt' } },
    ]);
    expect(parseWrittenCalls('<|tool_call>call:files__search_text{text:<|"|>yarrow<|"|>}<tool_call|>')).toEqual([{ name: 'files__search_text', arguments: { text: 'yarrow' } }]);
    expect(parseWrittenCalls('<call:files__read_text_file path="C:\\notes\\temp.txt"/>')).toEqual([{ name: 'files__read_text_file', arguments: { path: 'C:\\notes\\temp.txt' } }]);
    expect(scan(['Let me check. [tool_call:files__read_text_file{path:<|"|>x.txt<|"|>}]']).said).toBe('Let me check. ');
  });

  it('reads JSON-shaped calls, several arguments, numbers, and a call with none', () => {
    expect(parseWrittenCalls('<tool_call>{"name": "files__search_text", "arguments": {"text": "yarrow", "path": ""}}</tool_call>')).toEqual([
      { name: 'files__search_text', arguments: { text: 'yarrow', path: '' } },
    ]);
    expect(parseWrittenCalls('[tool:files__read_text_file(path="herbs.txt", from_line=120)]')).toEqual([
      { name: 'files__read_text_file', arguments: { path: 'herbs.txt', from_line: 120 } },
    ]);
    expect(parseWrittenCalls('[tool:files__read_text_file({"path": "herbs.txt"})]')).toEqual([{ name: 'files__read_text_file', arguments: { path: 'herbs.txt' } }]);
    expect(parseWrittenCalls('[tool:files__list_allowed_directories()]')).toEqual([{ name: 'files__list_allowed_directories', arguments: {} }]);
    expect(parseWrittenCalls('[tool:]')).toEqual([]);
  });

  it('says everything before a written call, holds the call back, and never says what follows it', () => {
    const { said, calls } = scan(['Let me check that for you. [to', 'ol:files__read_text_file(path="x.txt")]', ' It says the tea is warming.']);
    expect(said).toBe('Let me check that for you. ');
    expect(calls).toEqual([{ name: 'files__read_text_file', arguments: { path: 'x.txt' } }]);
  });

  it('lets her tags and other brackets through, a delta at a time', () => {
    const { said, calls } = scan(['[emote:happy] Hi', ' [', 'gesture:nod] a <b> and [1] and [t', 'ea]', ' end <']);
    expect(said).toBe('[emote:happy] Hi [gesture:nod] a <b> and [1] and [tea] end <');
    expect(calls).toEqual([]);
  });
});
