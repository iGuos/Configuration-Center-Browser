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

function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.includes("\n") ? JSON.stringify(v) : v;
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

const unquote = (s: string) => s.replace(/^(["'])(.*)\1$/, "$2");

/** 还原 properties 转义:\uXXXX、\t \n \r \f,其余 \X 取 X。 */
function unescapeProps(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c: string) => {
    if (c.length === 5) return String.fromCharCode(parseInt(c.slice(1), 16));
    return { t: "\t", n: "\n", r: "\r", f: "\f" }[c] ?? c;
  });
}

/** Java properties:# / ! 注释、行尾奇数个 \ 续行、分隔符为 = : 或空白。 */
function propertiesEntries(text: string): Entry[] {
  const out: Entry[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = i + 1;
    let logical = lines[i].replace(/^\s+/, "");
    if (!logical || logical[0] === "#" || logical[0] === "!") continue;
    // 续行:末尾连续反斜杠为奇数个时,拼上下一行(去掉其行首空白)
    while (/(^|[^\\])(\\\\)*\\$/.test(logical) && i + 1 < lines.length) {
      logical = logical.slice(0, -1) + lines[++i].replace(/^\s+/, "");
    }
    const m = logical.match(/^((?:\\.|[^\\\s=:])*)\s*[=:]?\s*(.*)$/s)!;
    const key = unescapeProps(m[1]);
    const value = unescapeProps(m[2].replace(/\s+$/, ""));
    out.push({ key, value: value.includes("\n") ? JSON.stringify(value) : value, line });
  }
  return out;
}

type LineMode = "yaml" | "toml" | "raw";

/** 逐行解析(YAML 解析失败的兜底 / properties / TOML / 其它文本)。 */
function lineEntries(text: string, mode: LineMode): Entry[] {
  const out: Entry[] = [];
  const stack: { indent: number; key: string }[] = []; // yaml 兜底:按缩进还原父级
  let section = ""; // toml:[section]
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  lines.forEach((src, idx) => {
    const line = idx + 1;
    let t = src.trim();
    if (!t) return;
    if (mode === "raw" ? /^<!--.*-->$/.test(t) : /^(#|!|;|\/\/)/.test(t)) return;
    if (mode === "toml") {
      const sec = t.match(/^\[+([^\]]+)\]+$/);
      if (sec) {
        section = sec[1].trim();
        return;
      }
    }
    // 行尾注释:空白后的 #(raw 模式下 XML / HTML 里的 # 是正文,不剥)
    if (mode === "yaml" || mode === "toml") t = t.replace(/\s+#.*$/, "");
    const m = mode === "raw" ? null : t.match(/^([^=:\s][^=:]*?)\s*([=:])\s*(.*)$/);
    if (!m) {
      out.push({ key: t, value: "", line, raw: true });
      return;
    }
    let key = unquote(m[1].trim());
    const value = unquote(m[3].trim());
    if (mode === "toml" && section) key = `${section}.${key}`;
    if (mode === "yaml" && m[2] === ":") {
      const indent = src.match(/^\s*/)![0].replace(/\t/g, "  ").length;
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const full = [...stack.map((s) => s.key), key].join(".");
      if (value === "") stack.push({ indent, key });
      key = full;
    }
    out.push({ key, value, line });
  });
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
