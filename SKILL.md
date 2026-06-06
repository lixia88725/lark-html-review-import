---
name: lark-html-review-import
description: Import local HTML review reports into Feishu/Lark Docx documents when the HTML contains a feedback table with screenshot images and preview videos, especially review.html-style files with local assets such as marker-001.mp4 and marker-007.jpg that must appear in the same table cells as the original HTML.
---

# Lark HTML Review Import

Use this skill to convert a local HTML review report into a Feishu/Lark cloud document while preserving the HTML table and embedding local screenshots and videos in the Preview column.

This workflow assumes `lark-cli` is installed and authenticated as a user. Use the relevant `lark-*` skills for auth setup or permission errors.

## Core Rule

Do not trust direct HTML import for local media.

`lark-cli drive +import --type docx --file ./review.html` can preserve the table and text, but local media conversion is incomplete:

- Local `<video>` elements commonly become plain `▶` text.
- Local `<img>` elements may become broken image blocks with the UI message "无法导入该图片，请从原文档中保存原图后重新上传。"

Therefore always run a media repair pass after importing:

- Re-upload each local image into the corresponding Image Block with `docs +media-upload --parent-type docx_image`.
- Create each video as a `view_type=2` File Block inside the original table cell, upload the `.mp4` with `docs +media-upload --parent-type docx_file`, then bind it with `replace_file`.

## Preferred Workflow

1. Locate the HTML file and its local assets directory.
2. Parse the HTML table rows. Record the marker number, Preview media path, and whether it is image or video.
3. Import the HTML as Docx from the HTML directory, using a relative `--file` path:

   ```bash
   cd /path/to/report
   lark-cli drive +import --type docx --file ./review.html --name "Review Name" --as user
   ```

4. Get the imported document token and locate the table block.
5. Read the table block's `table.cells`. For a 5-column report table with header row, marker `N` Preview cell is:

   ```text
   table.cells[N * 5 + 3]
   ```

6. For image rows:

   - Get the Preview cell's first child Image Block.
   - Upload the local image to that block:

     ```bash
     lark-cli docs +media-upload \
       --file ./assets/marker-007.jpg \
       --parent-type docx_image \
       --parent-node <image_block_id> \
       --doc-id <doc_id> \
       --as user
     ```

   - Bind the returned token:

     ```bash
     lark-cli api PATCH /open-apis/docx/v1/documents/<doc_id>/blocks/<image_block_id> \
       --params '{"document_revision_id":-1}' \
       --data '{"replace_image":{"token":"<image_token>","width":320,"height":180}}' \
       --as user
     ```

7. For video rows:

   - Delete text/image placeholders from the Preview cell if they exist.
   - Create a preview File Block in the cell:

     ```bash
     lark-cli api POST /open-apis/docx/v1/documents/<doc_id>/blocks/<preview_cell_id>/children \
       --params '{"document_revision_id":-1}' \
       --data '{"index":0,"children":[{"block_type":23,"file":{"token":"","view_type":2}}]}' \
       --as user
     ```

   - The response returns a View Block (`block_type=33`) with a child File Block (`block_type=23`). Use the File Block ID as `--parent-node`.
   - Upload the local video:

     ```bash
     lark-cli docs +media-upload \
       --file ./assets/marker-001.mp4 \
       --parent-type docx_file \
       --parent-node <file_block_id> \
       --doc-id <doc_id> \
       --as user
     ```

   - Bind the returned token:

     ```bash
     lark-cli api PATCH /open-apis/docx/v1/documents/<doc_id>/blocks/<file_block_id> \
       --params '{"document_revision_id":-1}' \
       --data '{"replace_file":{"token":"<video_token>"}}' \
       --as user
     ```

8. Verify:

   - Total table cells match expected row count and columns.
   - Every video row has one `block_type=33` View Block with `view_type=2`, containing a `block_type=23` File Block whose name matches the local `.mp4`.
   - Every image row has an Image Block (`block_type=27`) with a newly uploaded token.
   - Sample at least the first and last image token with:

     ```bash
     lark-cli docs +media-preview --token <image_token> --output ./preview-check.jpg --overwrite --as user
     ```

## Automation Script

Use `scripts/import_html_review_to_lark.mjs` for review.html-style reports.

Example:

```bash
node /path/to/lark-html-review-import/scripts/import_html_review_to_lark.mjs \
  --html "/path/to/试映_Review_20260602_V1/review.html" \
  --name "试映_Review_20260602_V1"
```

The script expects a table with 5 columns in this order:

```text
# | Start | Length | Preview | Comment
```

The first column must contain numeric marker indexes matching local assets such as `assets/marker-001.mp4` or `assets/marker-007.jpg`.

## Practical Notes

- Run `lark-cli` commands from the HTML directory when passing local files; several shortcuts reject absolute paths.
- Use `--as user` for user-owned Drive/Docx operations.
- Keep operations serial and lightly throttled. Docx block APIs can return `EOF` or truncated JSON under load; retry transient transport failures.
- If a direct full block-tree fetch starts failing after many videos are embedded, validate by reading individual table cells and child blocks instead of calling `blocks --page-all`.
- Do not silently settle for video links or attachment cards if the user asked for embedded videos. Use `file.view_type=2` at File Block creation time.
