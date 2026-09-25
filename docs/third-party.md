# PDF 依赖

Mozilla PDF.js 6.3.289 随扩展分发，用于打开 PDF、渲染页面及文字层、按需提取文字。运行时不从 CDN 加载代码。

| 内容 | 本地目录 |
| --- | --- |
| PDF.js legacy 主模块与 worker | src/vendor/pdfjs |
| PDFViewer 模块、样式和图标 | src/vendor/pdfjs |
| 字符映射、标准字体和许可证 | src/vendor/pdfjs |

包来源为官方 npm 注册表，下载时核对固定的 SHA-512 完整性值。src/vendor/pdfjs/package-info.json 记录包地址及校验值。tools/vendor-documents.js 可重新获取相同版本，需要联网；普通构建无需联网。

上游项目：[Mozilla PDF.js](https://github.com/mozilla/pdf.js)。许可证保存在 src/vendor/pdfjs/LICENSE。

本版移除了 PPT / PPTX 支持，相应的 fflate 和 SheetJS CFB 库不再包含在安装包中。
