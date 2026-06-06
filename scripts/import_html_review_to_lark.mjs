#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--html") out.html = args[++i];
    else if (args[i] === "--name") out.name = args[++i];
    else if (args[i] === "--as") out.as = args[++i];
    else if (args[i] === "--image-width") out.imageWidth = Number(args[++i]);
    else if (args[i] === "--image-height") out.imageHeight = Number(args[++i]);
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (!out.html) throw new Error("Missing --html /path/to/review.html");
  out.html = path.resolve(out.html);
  out.name ??= path.basename(out.html, path.extname(out.html));
  out.as ??= "user";
  out.imageWidth ??= 320;
  out.imageHeight ??= 180;
  return out;
}

function run(args, options = {}) {
  const stdout = execFileSync("lark-cli", args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    maxBuffer: 80 * 1024 * 1024,
  });
  const start = stdout.indexOf("{");
  if (start === -1) return stdout;
  return JSON.parse(stdout.slice(start));
}

function runRetry(args, options = {}, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return run(args, options);
    } catch (error) {
      lastError = error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 900);
    }
  }
  throw lastError;
}

function parseRows(htmlFile) {
  const rootDir = path.dirname(htmlFile);
  const html = readFileSync(htmlFile, "utf8");
  const rows = [];
  for (const match of html.matchAll(/<tr>(.*?)<\/tr>/gs)) {
    const cells = [...match[1].matchAll(/<td>(.*?)<\/td>/gs)].map((m) => m[1]);
    if (cells.length !== 5) continue;
    const index = Number(cells[0].replace(/<[^>]+>/g, "").trim());
    if (!Number.isFinite(index)) continue;
    const video = cells[3].match(/<video\s+[^>]*src="([^"]+)"/);
    const image = cells[3].match(/<img\s+[^>]*src="([^"]+)"/);
    const relPath = video?.[1] ?? image?.[1];
    if (!relPath) continue;
    const filePath = path.join(rootDir, relPath);
    if (!existsSync(filePath)) throw new Error(`Missing media for marker ${index}: ${filePath}`);
    rows.push({
      index,
      kind: video ? "video" : "image",
      relPath,
      fileName: path.basename(filePath),
    });
  }
  if (rows.length === 0) throw new Error("No image/video rows found in HTML table");
  return rows;
}

function importDocx({ html, name, as }) {
  const rootDir = path.dirname(html);
  const relHtml = `./${path.basename(html)}`;
  const result = runRetry(
    ["drive", "+import", "--type", "docx", "--file", relHtml, "--name", name, "--as", as],
    { cwd: rootDir },
  );
  const token = result?.data?.token;
  const url = result?.data?.url;
  if (!token || !url) throw new Error(`Import did not return doc token/url: ${JSON.stringify(result)}`);
  return { token, url };
}

function getBlock(docId, blockId, as) {
  return runRetry(["api", "GET", `/open-apis/docx/v1/documents/${docId}/blocks/${blockId}`, "--as", as])?.data?.block;
}

function listBlocks(docId, as) {
  return runRetry(["api", "GET", `/open-apis/docx/v1/documents/${docId}/blocks`, "--page-all", "--as", as])?.data?.items ?? [];
}

function findTable(docId, as) {
  const blocks = listBlocks(docId, as);
  const tables = blocks.filter((block) => block.block_type === 31);
  if (tables.length === 0) throw new Error("No table block found in imported document");
  return tables[0];
}

async function deleteCellChildren(docId, cellId, as) {
  const cell = getBlock(docId, cellId, as);
  const count = cell?.children?.length ?? 0;
  if (count === 0) return;
  runRetry([
    "api",
    "DELETE",
    `/open-apis/docx/v1/documents/${docId}/blocks/${cellId}/children/batch_delete`,
    "--params",
    '{"document_revision_id":-1}',
    "--data",
    JSON.stringify({ start_index: 0, end_index: count }),
    "--as",
    as,
  ]);
  await sleep(450);
}

async function createImageBlock(docId, cellId, as, width, height) {
  const result = runRetry([
    "api",
    "POST",
    `/open-apis/docx/v1/documents/${docId}/blocks/${cellId}/children`,
    "--params",
    '{"document_revision_id":-1}',
    "--data",
    JSON.stringify({ index: 0, children: [{ block_type: 27, image: { token: "", width, height } }] }),
    "--as",
    as,
  ]);
  await sleep(450);
  return result?.data?.children?.[0]?.block_id;
}

async function replaceImage({ docId, rootDir, row, cellId, as, width, height }) {
  let cell = getBlock(docId, cellId, as);
  let imageId = cell?.children?.[0];
  let imageBlock = imageId ? getBlock(docId, imageId, as) : null;
  if (imageBlock?.block_type !== 27) {
    await deleteCellChildren(docId, cellId, as);
    imageId = await createImageBlock(docId, cellId, as, width, height);
    imageBlock = imageId ? getBlock(docId, imageId, as) : null;
  }
  if (imageBlock?.block_type !== 27) throw new Error(`Marker ${row.index}: cannot create/find image block`);

  const uploaded = runRetry(
    [
      "docs",
      "+media-upload",
      "--file",
      `./${row.relPath}`,
      "--parent-type",
      "docx_image",
      "--parent-node",
      imageId,
      "--doc-id",
      docId,
      "--as",
      as,
    ],
    { cwd: rootDir },
  );
  const token = uploaded?.data?.file_token;
  if (!token) throw new Error(`Marker ${row.index}: image upload returned no token`);
  runRetry([
    "api",
    "PATCH",
    `/open-apis/docx/v1/documents/${docId}/blocks/${imageId}`,
    "--params",
    '{"document_revision_id":-1}',
    "--data",
    JSON.stringify({ replace_image: { token, width, height } }),
    "--as",
    as,
  ]);
  await sleep(450);
}

async function createVideoBlock(docId, cellId, as) {
  const result = runRetry([
    "api",
    "POST",
    `/open-apis/docx/v1/documents/${docId}/blocks/${cellId}/children`,
    "--params",
    '{"document_revision_id":-1}',
    "--data",
    '{"index":0,"children":[{"block_type":23,"file":{"token":"","view_type":2}}]}',
    "--as",
    as,
  ]);
  await sleep(450);
  const view = result?.data?.children?.[0];
  const fileBlockId = view?.children?.[0];
  if (!fileBlockId || view?.view?.view_type !== 2) {
    throw new Error(`Could not create preview file block in cell ${cellId}`);
  }
  return fileBlockId;
}

async function replaceVideo({ docId, rootDir, row, cellId, as }) {
  await deleteCellChildren(docId, cellId, as);
  const fileBlockId = await createVideoBlock(docId, cellId, as);
  const uploaded = runRetry(
    [
      "docs",
      "+media-upload",
      "--file",
      `./${row.relPath}`,
      "--parent-type",
      "docx_file",
      "--parent-node",
      fileBlockId,
      "--doc-id",
      docId,
      "--as",
      as,
    ],
    { cwd: rootDir },
  );
  const token = uploaded?.data?.file_token;
  if (!token) throw new Error(`Marker ${row.index}: video upload returned no token`);
  runRetry([
    "api",
    "PATCH",
    `/open-apis/docx/v1/documents/${docId}/blocks/${fileBlockId}`,
    "--params",
    '{"document_revision_id":-1}',
    "--data",
    JSON.stringify({ replace_file: { token } }),
    "--as",
    as,
  ]);
  await sleep(450);
}

async function main() {
  const opts = parseArgs();
  const rootDir = path.dirname(opts.html);
  const rows = parseRows(opts.html);
  console.log(`Found ${rows.length} media rows`);

  const doc = importDocx(opts);
  console.log(`Imported document: ${doc.url}`);

  const table = findTable(doc.token, opts.as);
  const cells = table?.table?.cells;
  const rowSize = table?.table?.property?.row_size;
  if (!Array.isArray(cells) || !rowSize) throw new Error("Imported table has no cells/row_size");
  const columns = cells.length / rowSize;
  if (columns !== 5) throw new Error(`Expected 5 columns, got ${columns}`);

  let images = 0;
  let videos = 0;
  for (const row of rows) {
    const previewCell = cells[row.index * columns + 3];
    if (!previewCell) throw new Error(`Marker ${row.index}: no preview cell`);
    if (row.kind === "image") {
      await replaceImage({
        docId: doc.token,
        rootDir,
        row,
        cellId: previewCell,
        as: opts.as,
        width: opts.imageWidth,
        height: opts.imageHeight,
      });
      images += 1;
    } else {
      await replaceVideo({ docId: doc.token, rootDir, row, cellId: previewCell, as: opts.as });
      videos += 1;
    }
    console.log(`Embedded marker-${String(row.index).padStart(3, "0")} ${row.kind}`);
  }

  console.log(JSON.stringify({ ok: true, url: doc.url, doc_id: doc.token, rows: rows.length, images, videos }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
