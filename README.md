# Lark HTML Review Import

将本地 HTML 审阅报告导入飞书文档，自动修复截图和视频。

## 问题

`lark-cli drive +import --type docx` 导入 HTML 时，本地媒体会丢失：
- `<video>` 变成纯文本 `▶`
- `<img>` 变成"无法导入该图片"的占位符

## 解决方案

导入后自动执行媒体修复：
- 重新上传本地图片到对应的 Image Block
- 创建 `view_type=2` 的 File Block 并上传视频

## 快速开始

```bash
node scripts/import_html_review_to_lark.mjs \
  --html "/path/to/试映_Review_20260602_V1/review.html" \
  --name "试映_Review_20260602_V1"
```

## 要求

- `lark-cli` 已安装并认证为用户
- HTML 包含 5 列表格：`# | Start | Length | Preview | Comment`
- 第一列为数字索引，对应本地资源文件（如 `assets/marker-001.mp4`、`assets/marker-007.jpg`）

## 文件结构

```
lark-html-review-import/
├── SKILL.md                              # Hermes Agent skill 定义
├── scripts/import_html_review_to_lark.mjs # 自动化脚本
└── agents/openai.yaml                    # OpenAI Agent 配置
```

## 手动流程

1. 定位 HTML 文件和本地资源目录
2. 解析表格行，记录标记号、媒体路径、类型（图片/视频）
3. 从 HTML 目录导入为 Docx：
   ```bash
   cd /path/to/report
   lark-cli drive +import --type docx --file ./review.html --name "Review Name" --as user
   ```
4. 获取文档 token，定位表格 block
5. 修复图片：上传并绑定 Image Block
6. 修复视频：创建 File Block，上传 `.mp4`，绑定

## 注意事项

- 从 HTML 目录运行 `lark-cli`，部分命令不支持绝对路径
- 用户操作使用 `--as user`
- 操作保持串行，Docx block API 在高负载时可能返回 `EOF`
- 如需嵌入视频而非链接，创建 File Block 时必须设置 `file.view_type=2`

## License

MIT
