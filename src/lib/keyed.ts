// 按 key 对齐的对比:把配置解析成「完整键路径 → 值」条目,同一个 key 放在同一行比较。
// - 注释(整行和行尾)全部丢弃,不参与对比;
// - YAML / JSON 嵌套展开成 a.b.c,数组用 a[0],排序后同一父级的 key 仍挨在一起;
// - 解析不了的行原样作为一条,只按整行对齐。

import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";
import type { Document, Node } from "yaml";
import type { DiffResult, DiffRow } from "./diff";
import type { Format } from "./format";

export interface Entry {
  /** 完整键路径;不是键值对的行为整行原文。 */
  key: string;
  value: string;
  /** 源文件行号(1 起),拿不到时为 null。 */
  line: number | null;
  /** 整行原文(不是键值对),对齐时只看整行。 */
  raw?: boolean;
}

/** 多行文本压成一行显示(换行写成 \n)。末尾换行不算差异:
 *  同一段证书用 `|` 块写会带末尾换行,用引号写不带,不应判成不同。 */
function fmtText(v: string): string {
  const t = v.replace(/\n+$/, "");
  return t.includes("\n") ? JSON.stringify(t) : t;
}

function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return fmtText(v);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** 递归展开 YAML 节点。line 为该节点 key 所在行。 */
function walkYaml(
  node: unknown,
  path: string,
  doc: Document,
  lc: LineCounter,
  out: Entry[],
  line: number | null
) {
  const lineOf = (n: unknown) => {
    const r = (n as Node | null)?.range;
    return r ? lc.linePos(r[0]).line : line;
  };
  if (isMap(node)) {
    if (!node.items.length) {
      out.push({ key: path, value: "{}", line });
      return;
    }
    for (const pair of node.items) {
      const k = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
      walkYaml(pair.value, path ? `${path}.${k}` : k, doc, lc, out, lineOf(pair.key));
    }
  } else if (isSeq(node)) {
    if (!node.items.length) {
      out.push({ key: path, value: "[]", line });
      return;
    }
    node.items.forEach((it, i) => walkYaml(it, `${path}[${i}]`, doc, lc, out, lineOf(it)));
  } else {
    const v = isScalar(node)
      ? node.value
      : isAlias(node)
        ? node.resolve(doc)?.toJSON()
        : null;
    out.push({ key: path, value: fmtValue(v), line });
  }
}

const unquote = (s: string) => s.replace(/^(["'])(.*)\1$/s, "$2");

const PEM_BEGIN = /-----BEGIN [^-]+-----/;
const PEM_END = /-----END [^-]+-----/;
const MAX_MULTILINE = 200;

const indentOf = (src: string) => src.match(/^\s*/)![0].replace(/\t/g, "  ").length;

/** 逐行兜底时识别跨行的值,合并回所属的 key。配置里只要有一处不是合法 YAML,整份都会落到
 *  兜底,所以规范写法(`|` 块)和不规范写法(私钥 / 密文顶格直接贴)都要认:
 *  - `|` / `>` 块:后面比 key 缩进更深的行;
 *  - `|` 块或空值后面紧跟顶格的 PEM(-----BEGIN … 到 -----END …);
 *  - key 同一行上引号没闭合,或 PEM 块没结束。
 *  返回合并后的值和多用掉的行数;不是跨行值返回 null(找不到结尾也返回 null,不吞后面的行)。 */
function multilineValue(
  first: string,
  lines: string[],
  next: number,
  keyIndent: number
): { value: string; used: number } | null {
  // 从 from 行起收集到满足 closed 的那一行(含)
  const until = (from: number, head: string[], closed: (l: string) => boolean) => {
    const parts = [...head];
    for (let j = from; j < lines.length && j - from < MAX_MULTILINE; j++) {
      const l = lines[j].trim();
      parts.push(l);
      if (closed(l)) return { value: unquote(parts.join("\n")), used: j - next + 1 };
    }
    return null;
  };

  const block = first.match(/^([|>])[-+0-9]*$/);
  if (block || first === "") {
    let j = next;
    while (j < lines.length && !lines[j].trim()) j++;
    if (j >= lines.length) return null;
    if (/^-----BEGIN /.test(lines[j].trim())) return until(j, [], (l) => PEM_END.test(l));
    if (!block) return null;
    const body: string[] = [];
    let k = j;
    for (; k < lines.length; k++) {
      if (lines[k].trim() && indentOf(lines[k]) <= keyIndent) break;
      body.push(lines[k]);
    }
    while (body.length && !body[body.length - 1].trim()) body.pop();
    if (!body.length) return null;
    const dedent = Math.min(...body.filter((l) => l.trim()).map(indentOf));
    const text = body.map((l) => l.replace(/\t/g, "  ").slice(dedent).replace(/\s+$/, ""));
    return { value: text.join(block[1] === ">" ? " " : "\n"), used: j - next + body.length };
  }

  const q = first[0];
  if ((q === '"' || q === "'") && !(first.length > 1 && first.endsWith(q))) {
    return until(next, [first], (l) => l.endsWith(q));
  }
  if (PEM_BEGIN.test(first) && !PEM_END.test(first)) {
    return until(next, [first], (l) => PEM_END.test(l));
  }
  return null;
}

type LineMode = "yaml" | "toml" | "raw";

/** 逐行解析(YAML 解析失败的兜底 / properties / TOML / 其它文本)。 */
function lineEntries(text: string, mode: LineMode): Entry[] {
  const out: Entry[] = [];
  const stack: { indent: number; key: string }[] = []; // yaml 兜底:按缩进还原父级
  let section = ""; // toml:[section]
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let idx = 0; idx < lines.length; idx++) {
    const src = lines[idx];
    const line = idx + 1;
    let t = src.trim();
    if (!t) continue;
    if (mode === "raw" ? /^<!--.*-->$/.test(t) : /^(#|!|;|\/\/)/.test(t)) continue;
    if (mode === "toml") {
      const sec = t.match(/^\[+([^\]]+)\]+$/);
      if (sec) {
        section = sec[1].trim();
        continue;
      }
    }
    // 行尾注释:空白后的 #(raw 模式下 XML / HTML 里的 # 是正文,不剥)
    if (mode === "yaml" || mode === "toml") t = t.replace(/\s+#.*$/, "");
    const m = mode === "raw" ? null : t.match(/^([^=:\s][^=:]*?)\s*([=:])\s*(.*)$/);
    if (!m) {
      out.push({ key: t, value: "", line, raw: true });
      continue;
    }
    let key = unquote(m[1].trim());
    let value = unquote(m[3].trim());
    const multi =
      mode === "yaml" ? multilineValue(m[3].trim(), lines, idx + 1, indentOf(src)) : null;
    if (multi) {
      value = fmtText(multi.value);
      idx += multi.used;
    }
    if (mode === "toml" && section) key = `${section}.${key}`;
    if (mode === "yaml" && m[2] === ":") {
      const indent = indentOf(src);
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const full = [...stack.map((s) => s.key), key].join(".");
      if (value === "") stack.push({ indent, key });
      key = full;
    }
    out.push({ key, value, line });
  }
  if (mode !== "yaml") return out;
  // yaml 兜底:去掉只起分组作用的父级行(如 `db:`),它们的子项已带完整路径
  const parents = new Set(out.map((e) => e.key.slice(0, e.key.lastIndexOf("."))));
  return out.filter((e) => e.raw || e.value !== "" || !parents.has(e.key));
}

/** 把配置内容解析为条目。YAML / JSON 优先走真正的解析器,失败再逐行兜底。 */
export function parseEntries(text: string, fmt: Format): Entry[] {
  if (fmt === "Properties") return propertiesEntries(text);
  if (fmt === "TOML") return lineEntries(text, "toml");
  if (fmt === "XML" || fmt === "HTML") return lineEntries(text, "raw");
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, uniqueKeys: false });
  if (!doc.errors.length && isMap(doc.contents)) {
    const out: Entry[] = [];
    walkYaml(doc.contents, "", doc, lc, out, null);
    return out;
  }
  return lineEntries(text, "yaml");
}

/** 按 key 对齐两侧条目。keysOnly 时只看 key 是否存在,忽略值。 */
export function diffByKey(left: Entry[], right: Entry[], keysOnly = false): DiffResult {
  const group = (es: Entry[]) => {
    const m = new Map<string, Entry[]>();
    for (const e of es) {
      const arr = m.get(e.key);
      if (arr) arr.push(e);
      else m.set(e.key, [e]);
    }
    return m;
  };
  const L = group(left);
  const R = group(right);
  const keys = Array.from(new Set([...L.keys(), ...R.keys()])).sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  const show = (e: Entry) => (e.raw || keysOnly ? e.key : `${e.key}: ${e.value}`);

  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let modified = 0;
  for (const k of keys) {
    const a = L.get(k) ?? [];
    const b = R.get(k) ?? [];
    // 同一 key 出现多次(重复键 / 相同的原文行)按出现顺序一一配对
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const l = a[i];
      const r = b[i];
      if (l && r) {
        const same = keysOnly || l.value === r.value;
        if (!same) modified++;
        rows.push({
          type: same ? "equal" : "modify",
          leftNo: l.line,
          rightNo: r.line,
          left: show(l),
          right: show(r),
        });
      } else if (l) {
        removed++;
        rows.push({ type: "del", leftNo: l.line, rightNo: null, left: show(l), right: null });
      } else {
        added++;
        rows.push({ type: "add", leftNo: null, rightNo: r.line, left: null, right: show(r) });
      }
    }
  }
  return { rows, added, removed, modified };
}
