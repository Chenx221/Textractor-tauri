#!/usr/bin/env node
/**
 * 把发布 tag 映射成 semver，并写入 package.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml。
 *
 * 用法：
 *   node scripts/set-version.mjs v260927      # -> 26.9.27
 *   node scripts/set-version.mjs 1.2.3        # 原样使用（也接受 v1.2.3）
 *
 * stdout 只输出最终版本号（一行），日志全部走 stderr，方便 workflow 直接取用：
 *   $version = (node scripts/set-version.mjs $tag).Trim()
 *
 * 为什么需要映射：Windows 的 MSI(WiX) 只接受 `major.minor.build` 形式的 semver
 * （各段 0-255 / build 最大 65535），所以日期式 tag 必须转成 26.9.27 这种形式。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

const tag = (process.argv[2] ?? "").trim();
if (!tag) {
  fail("usage: node scripts/set-version.mjs <tag>   (例如 v260927 或 v1.2.3)");
}

const raw = tag.replace(/^v/i, "");

/** 计算 semver。 */
let version;
const dateMatch = /^(\d{2})(\d{2})(\d{2})$/.exec(raw);
if (dateMatch) {
  // v260927 -> 2026-09-27 -> 26.9.27（去掉前导零，避免 MSI 把 "09" 当成八进制）
  version = `${Number(dateMatch[1])}.${Number(dateMatch[2])}.${Number(dateMatch[3])}`;
} else if (/^\d+\.\d+\.\d+$/.test(raw)) {
  version = raw;
} else {
  fail(`无法从 tag "${tag}" 推导版本号：支持 vYYMMDD 或 vMAJOR.MINOR.PATCH`);
}

const segments = version.split(".").map(Number);
if (segments.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
  fail(`版本号 ${version} 超出 MSI 允许范围（各段 0-255）`);
}
console.error(`tag ${tag} -> version ${version}`);

function detectEol(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function writeJsonVersion(file, setVersion) {
  const path = join(root, file);
  const original = readFileSync(path, "utf8");
  const eol = detectEol(original);
  const finalNewline = original.endsWith("\n") ? eol : "";
  const data = JSON.parse(original);
  const before = data.version;
  setVersion(data);
  const text = JSON.stringify(data, null, 2).split("\n").join(eol) + finalNewline;
  writeFileSync(path, text, "utf8");
  console.error(`${file}: ${before} -> ${data.version}`);
}

writeJsonVersion("package.json", (data) => {
  data.version = version;
});

writeJsonVersion("src-tauri/tauri.conf.json", (data) => {
  data.version = version;
});

// Cargo.toml：只改 [package] 段里的 version（依赖里也有 version = 行，不能误伤）。
{
  const file = "src-tauri/Cargo.toml";
  const path = join(root, file);
  const original = readFileSync(path, "utf8");
  const blockStart = original.indexOf("[package]");
  if (blockStart < 0) fail(`${file}: 找不到 [package] 段`);
  const nextSection = original.indexOf("\n[", blockStart + 1);
  const blockEnd = nextSection < 0 ? original.length : nextSection + 1;
  const block = original.slice(blockStart, blockEnd);
  const replaced = block.replace(/^version\s*=\s*"[^"]*"/m, `version = "${version}"`);
  if (replaced === block) fail(`${file}: [package] 段里找不到 version`);
  writeFileSync(path, original.slice(0, blockStart) + replaced + original.slice(blockEnd), "utf8");
  console.error(`${file}: version -> ${version}（Cargo.lock 会在构建时自动同步）`);
}

// 只把版本号写到 stdout。
process.stdout.write(`${version}\n`);
