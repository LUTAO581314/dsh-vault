#!/usr/bin/env python
"""PDF 拆解器（论文画图工作室用）—— 纯 PyMuPDF + 标准库，无其它依赖。

用法:
    python pdf-extract.py <paper.pdf> [--out ref/] [--dpi 300] [--pages 1-3,5] [--no-images]

产出（默认 --out 为 PDF 同级的 <pdfname>.extracted/）:
    <out>/text.md            按页分隔的正文纯文本（含页码标记，便于回指原文）
    <out>/pages/pNNN.png     每页 300dpi 位图（给 modlens_read_image 看图用）
    <out>/images/...         页内嵌图原图（论文里的 Figure 常常就是它）
    <out>/summary.txt        每页字符数 / 图片数 / 表格线数，一眼看出哪页有图

只依赖 pymupdf（本机已装：python -c "import pymupdf"）。
"""
import argparse
import os
import sys

try:
    import pymupdf
except ImportError:  # pragma: no cover
    print("missing pymupdf: python -m pip install pymupdf", file=sys.stderr)
    raise SystemExit(2)


def parse_pages(spec, total):
    if not spec or spec.lower() in ("all", "*"):
        return list(range(total))
    out = []
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "-" in chunk:
            a, b = chunk.split("-", 1)
            out += [i - 1 for i in range(int(a), int(b) + 1)]
        else:
            out.append(int(chunk) - 1)
    return [i for i in out if 0 <= i < total]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--out", default="")
    ap.add_argument("--dpi", type=int, default=300)
    ap.add_argument("--pages", default="all")
    ap.add_argument("--no-images", action="store_true")
    args = ap.parse_args()

    src = os.path.abspath(args.pdf)
    if not os.path.isfile(src):
        print(f"file not found: {src}", file=sys.stderr)
        return 2
    out = args.out or os.path.join(os.path.dirname(src), os.path.splitext(os.path.basename(src))[0] + ".extracted")
    os.makedirs(os.path.join(out, "pages"), exist_ok=True)
    if not args.no_images:
        os.makedirs(os.path.join(out, "images"), exist_ok=True)

    doc = pymupdf.open(src)
    total = doc.page_count
    pages = parse_pages(args.pages, total)

    text_parts = [f"# {os.path.basename(src)}\n\n总页数 {total}；抽取页 {[p + 1 for p in pages]}\n"]
    rows = []
    for idx in pages:
        page = doc[idx]
        txt = page.get_text("text")
        text_parts.append(f"\n\n===== PAGE {idx + 1} =====\n{txt}")

        png = os.path.join(out, "pages", f"p{idx + 1:03d}.png")
        page.get_pixmap(dpi=args.dpi).save(png)

        n_img = 0
        if not args.no_images:
            for j, info in enumerate(page.get_images(full=True), 1):
                xref = info[0]
                try:
                    raw = doc.extract_image(xref)
                except Exception:
                    continue
                if not raw or not raw.get("image"):
                    continue
                if len(raw["image"]) < 4096:  # 跳过图标/装饰小图
                    continue
                n_img += 1
                ext = raw.get("ext", "png")
                with open(os.path.join(out, "images", f"p{idx + 1:03d}-{j}{'.' + ext}"), "wb") as fh:
                    fh.write(raw["image"])

        rows.append((idx + 1, len(txt), n_img))

    with open(os.path.join(out, "text.md"), "w", encoding="utf-8") as fh:
        fh.write("".join(text_parts))
    lines = ["page\tchars\timages"]
    lines += [f"{p}\t{c}\t{i}" for p, c, i in rows]
    with open(os.path.join(out, "summary.txt"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")

    print(f"out: {out}")
    for p, c, i in rows:
        print(f"  p{p}: {c} chars, {i} images")
    print("")
    print("next: captions are in text.md; look at pages with modlens_read_image(pages/pNNN.png);")
    print("      then write outline.md (figure list + node table + edge table + symbol table).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
