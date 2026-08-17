/**
 * Chequeo mínimo del CLI: slash parser, args, @refs y tilde. Sin red.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expandAtRefs } from "./commands.js";
import { findAtRefs, parseAgentMode, parseCliArgs, parseSlash, parseUiMode, nextUiMode, resolveWorkspace, setDirExistsForTests } from "./parse.js";
import { C, insideWorkspace, listVisibleTree } from "./midnight.js";
import { actionTitle, focusHunks, isWriteTrace, lineDiff, relFromTrace, splitDiff, reviewDiff } from "./review.js";
import { fitCols, visWidth } from "./diffview.js";
import { backspace, deleteRange, insert, loadDoc, mouseKind, newline, parseMouse, peelInput, redo, serialize, sliceRange, textToCopy, typeInto, undo } from "./buffer.js";

assert.equal(parseSlash("crea un hello"), null);
assert.deepEqual(parseSlash("/help"), { name: "help", args: "" });
assert.deepEqual(parseSlash("/"), { name: "help", args: "" });
assert.deepEqual(parseSlash("/q"), { name: "exit", args: "" });
assert.deepEqual(parseSlash("/quit"), { name: "exit", args: "" });
assert.deepEqual(parseSlash("/clear"), { name: "new", args: "" });
assert.deepEqual(parseSlash("/workspace ~/foo"), { name: "workspace", args: "~/foo" });
assert.deepEqual(parseSlash("/models deepseek-reasoner deepseek-chat"), {
  name: "models",
  args: "deepseek-reasoner deepseek-chat",
});
assert.deepEqual(parseSlash("/mode chat"), { name: "mode", args: "chat" });
assert.deepEqual(parseSlash("/modelo"), { name: "mode", args: "" });
assert.equal(parseAgentMode("squad"), "squad");
assert.equal(parseAgentMode("ask"), "chat");
assert.equal(parseAgentMode("nope"), null);
assert.equal(parseUiMode("editor"), "editor");
assert.equal(C.bg, "#12141d");
assert.equal(nextUiMode("chat"), "squad");
assert.equal(nextUiMode("squad"), "editor");
assert.equal(nextUiMode("editor"), "chat");

const home = os.homedir();
assert.equal(resolveWorkspace("~", "/tmp"), home);
assert.ok(resolveWorkspace("~/docs", "/tmp").startsWith(home));

assert.deepEqual(findAtRefs("mira @src/app.ts y @lib/x.ts"), ["src/app.ts", "lib/x.ts"]);
assert.deepEqual(findAtRefs("escribe a foo@bar.com"), []);

setDirExistsForTests((p) => p === "/tmp/proj");
const parsed = parseCliArgs(["/tmp/proj", "-p", "hola"], "/home/me", { SQUAD_API_URL: "http://x:1/" });
assert.equal(parsed.apiUrl, "http://x:1");
assert.equal(parsed.workspaceDir, "/tmp/proj");
assert.equal(parsed.prompt, "hola");

const noDir = parseCliArgs(["crea un login"], "/home/me", {});
assert.equal(noDir.prompt, "crea un login");
assert.equal(noDir.workspaceDir, undefined);

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "squad-cli-"));
await fs.writeFile(path.join(tmp, "hello.ts"), "export const n = 1;\n");
await fs.writeFile(path.join(tmp, ".env"), "SECRET=1\n");
const expanded = await expandAtRefs("revisa @hello.ts", tmp);
assert.match(expanded, /export const n = 1/);
const blocked = await expandAtRefs("no leas @.env", tmp);
assert.match(blocked, /protegido/);

await fs.mkdir(path.join(tmp, "node_modules"));
await fs.writeFile(path.join(tmp, "node_modules", "x.js"), "1");
const tree = await listVisibleTree(tmp, new Set());
assert.ok(tree.some((e) => e.name === "hello.ts"));
assert.equal(tree.some((e) => e.name === "node_modules"), false);
assert.equal(tree.some((e) => e.name === ".env"), true);
await fs.mkdir(path.join(tmp, "src"));
await fs.writeFile(path.join(tmp, "src", "a.ts"), "1");
assert.equal((await listVisibleTree(tmp, new Set())).some((e) => e.rel === "src/a.ts"), false);
assert.ok((await listVisibleTree(tmp, new Set(["src"]))).some((e) => e.rel === "src/a.ts"));
assert.ok(insideWorkspace(tmp, path.join(tmp, "hello.ts")));
assert.equal(insideWorkspace(tmp, tmp + "-evil/x"), false);

const d0 = loadDoc("ab\ncd");
const d1 = insert(d0, "x");
assert.equal(serialize(d1), "xab\ncd");
assert.equal(serialize(newline(d1)), "x\nab\ncd");
assert.equal(serialize(backspace(insert(loadDoc("ab"), "z"))), "ab");
const u0 = insert(loadDoc("ab"), "x");
assert.equal(serialize(undo(u0)), "ab");
assert.equal(serialize(redo(undo(u0))), "xab");
assert.equal(undo(loadDoc("ab")).past.length, 0);
const rng = loadDoc("hello\nworld");
assert.equal(sliceRange(rng, { row: 0, col: 1 }, { row: 1, col: 2 }), "ello\nwo");
assert.equal(serialize(deleteRange(rng, { row: 0, col: 1 }, { row: 0, col: 4 })), "ho\nworld");
assert.equal(textToCopy(rng, null), "hello\n");
const mouse = parseMouse("[<0;12;8M");
assert.equal(mouse?.btn, 0);
assert.equal(mouse?.x, 12);
assert.equal(mouse?.press, true);
assert.equal(parseMouse("[<64;1;1M")?.btn, 64);
assert.equal(mouseKind({ btn: 0, x: 1, y: 1, press: true }), "down");
assert.equal(mouseKind({ btn: 0, x: 1, y: 1, press: false }), "up");
assert.equal(mouseKind({ btn: 32, x: 2, y: 3, press: true }), "drag");
assert.equal(mouseKind({ btn: 64, x: 1, y: 1, press: true }), "wheel-up");
assert.equal(relFromTrace({ at: "", actor: "chat", event: "escribiendo src/a.ts", detail: "" }), "src/a.ts");
assert.equal(isWriteTrace({ at: "", actor: "qa", event: "aprobado src/a.ts", detail: "" }), true);
const dff = lineDiff("a\nb", "a\nc");
assert.deepEqual(dff.filter((r) => r.k !== " ").map((r) => `${r.k}${r.t}`), ["-b", "+c"]);
const side = splitDiff(dff);
assert.equal(side.length, 2);
assert.equal(side[1]?.left?.k, "-");
assert.equal(side[1]?.right?.k, "+");
assert.equal(side[1]?.left?.ln, 2);
assert.equal(side[1]?.right?.ln, 2);
const insertOnly = splitDiff(lineDiff("a\nc", "a\nb\nc"));
assert.equal(insertOnly[1]?.left, null);
assert.equal(insertOnly[1]?.right?.t, "b");
const longBefore = Array.from({ length: 20 }, (_, i) => String(i)).join("\n");
const longAfter = Array.from({ length: 20 }, (_, i) => (i === 10 ? "X" : String(i))).join("\n");
const hunks = reviewDiff(longBefore, longAfter);
assert.ok(hunks.some((r) => r.right?.t === "X"));
assert.ok(hunks.length < 20);
assert.equal(actionTitle("created"), "Create");
assert.equal(actionTitle("modified"), "Edit");
assert.equal(focusHunks(splitDiff(lineDiff("a", "a"))).length, 1);
assert.equal(fitCols("ab", 4), "ab  ");
assert.equal(fitCols("abcdef", 3), "abc");
assert.equal(visWidth("a✅"), 3);
assert.equal(visWidth(fitCols("a✅bcd", 3)), 3);

assert.equal(serialize(insert(loadDoc("ab"), "\x7f")), "ab");
assert.equal(serialize(typeInto(loadDoc("ab"), "x\x7f")), "ab");
assert.equal(serialize(typeInto(loadDoc(""), "a\x7fb")), "b");
assert.equal(serialize(typeInto(loadDoc(""), "xy")), "xy");
assert.equal(serialize(typeInto({ ...loadDoc("ab"), col: 2 }, "xy")), "abxy");
const peeled = peelInput("\x1b[<0;10;20Ma");
assert.equal(peeled.text, "a");
assert.equal(peeled.events[0]?.x, 10);
assert.equal(peelInput("[<0;1;2Mhi").text, "hi");
assert.equal(peelInput("[<0;17;54M[<0;17;54msdas").text, "sdas");
assert.equal(peelInput("[<0;17;54M[<0;17;54msdas").events.length, 2);

console.log("selfcheck ok");
