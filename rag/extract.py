"""첨부 파일에서 글 뽑기.

extract_text(path, ext, limit) -> (text, note)
  note: None | 'partial' | 'no_text' | 'unsupported' | 'error:<짧은 이유>'

이유는 정해 둔 짧은 낱말만 쓴다(missing · unreadable · encrypted · corrupt · too_large · failed).
예외 메시지나 파일 내용은 note 에도 로그에도 넣지 않는다.
"""

import codecs
import html.parser
import logging
import os
import re
import zipfile
from xml.etree import ElementTree

DEFAULT_LIMIT = 200_000
# docx · pptx · xlsx · hwpx 는 zip 이다. 실제로 읽는 XML 항목의 압축 푼 크기 합이 이것을 넘으면 읽지 않는다(zip 폭탄).
# 그림 · 동영상 같은 미디어 항목은 세지 않는다.
MAX_ZIP_BYTES = 50 * 1024 * 1024
# zip 이 아닌 형식(pdf)의 파일 크기 한도.
MAX_FILE_BYTES = 200 * 1024 * 1024
# PDF 에서 공백을 뺀 글자가 이보다 적으면 스캔(이미지) PDF 로 본다.
MIN_PDF_CHARS = 20
# PDF 는 이 쪽 수까지만 읽는다(넘으면 partial).
MAX_PDF_PAGES = 2000

# 형식마다 실제로 읽는 XML 항목(크기 한도에 세는 것).
_ZIP_PARTS = {
    "docx": re.compile(r"^word/[^/]+\.xml$", re.IGNORECASE),
    "pptx": re.compile(r"^ppt/(slides|notesSlides)/[^/]+\.xml$", re.IGNORECASE),
    "xlsx": re.compile(r"^xl/([^/]+|worksheets/[^/]+)\.xml$", re.IGNORECASE),
}

_BOMS = (
    (codecs.BOM_UTF8, "utf-8"),
    (codecs.BOM_UTF16_LE, "utf-16-le"),
    (codecs.BOM_UTF16_BE, "utf-16-be"),
)

TEXT_EXTS = {"txt", "md", "csv", "json", "log"}
HTML_EXTS = {"html", "htm"}
# HTML 은 태그 · 스크립트가 글자보다 훨씬 크다. 이 크기까지만 읽는다.
MAX_HTML_BYTES = 20 * 1024 * 1024
ZIP_EXTS = {"docx", "xlsx", "pptx", "hwpx"}

# pypdf 는 깨진 PDF 에서 경고를 많이 찍는다. 오류만 남긴다.
logging.getLogger("pypdf").setLevel(logging.ERROR)


class _TooLarge(Exception):
    pass


class _Encrypted(Exception):
    pass


class _Full(Exception):
    """글자 한도를 채웠다(더 읽지 않는다)."""


class _Collector:
    """조각을 모으다가 limit 를 넘으면 _Full 을 던져 읽기를 멈춘다."""

    def __init__(self, limit):
        self.limit = limit
        self.parts = []
        self.size = 0
        self.partial = False  # 한도(쪽 수 등) 때문에 일부만 읽었다

    def add(self, text):
        if not text:
            return
        self.parts.append(text)
        self.size += len(text)
        if self.size > self.limit:
            raise _Full

    def line(self, text):
        self.add(text + "\n")


def normalize_ext(ext, path=""):
    e = str(ext or "").strip().lower().lstrip(".")
    if not e and path:
        e = os.path.splitext(str(path))[1].lower().lstrip(".")
    return e


def extract_text(path, ext, limit=DEFAULT_LIMIT):
    e = normalize_ext(ext)
    if e in TEXT_EXTS:
        reader = _read_text
    elif e in HTML_EXTS:
        reader = _read_html
    elif e == "pdf":
        reader = _read_pdf
    elif e == "docx":
        reader = _read_docx
    elif e == "xlsx":
        reader = _read_xlsx
    elif e == "pptx":
        reader = _read_pptx
    elif e == "hwpx":
        reader = _read_hwpx
    else:
        return "", "unsupported"

    try:
        path = os.fspath(path)
        if not os.path.isfile(path):
            return "", "error:missing"
        if e == "pdf" and os.path.getsize(path) > MAX_FILE_BYTES:
            return "", "error:too_large"
        if e in ZIP_EXTS and not zipfile.is_zipfile(path):
            return "", "error:corrupt"
        collector = _Collector(limit)
        try:
            special = reader(path, collector)
        except _Full:
            special = None
        if special:
            return "", special
        text = "".join(collector.parts).replace("\x00", "").strip()
    except _TooLarge:
        return "", "error:too_large"
    except _Encrypted:
        return "", "error:encrypted"
    except FileNotFoundError:
        return "", "error:missing"
    except PermissionError:
        return "", "error:unreadable"
    except (zipfile.BadZipFile, ElementTree.ParseError, KeyError, EOFError):
        return "", "error:corrupt"
    except MemoryError:
        return "", "error:too_large"
    except Exception as err:  # noqa: BLE001 — 어떤 파일도 서버를 죽이지 않는다
        return "", "error:corrupt" if _looks_corrupt(err) else "error:failed"

    if len(text) > limit:
        return text[:limit], "partial"
    return text, "partial" if collector.partial else None


def _looks_corrupt(err):
    name = type(err).__name__
    return name in ("PdfReadError", "PdfStreamError", "PackageNotFoundError", "InvalidFileException") or (
        isinstance(err, ValueError)
    )


# ---------- 글자 파일 ----------


def _read_text(path, out):
    # 한 글자는 utf-8 에서 최대 4바이트. 한도보다 조금 더 읽어 partial 여부를 안다.
    out.add(_decode_file(path, out.limit * 4 + 4))


def _decode_file(path, cap):
    """파일을 cap 바이트까지 읽어 글자로 바꾼다(BOM → utf-8 → cp949 순으로 믿는다)."""
    with open(path, "rb") as f:
        raw = f.read(cap + 1)
    truncated = len(raw) > cap
    if truncated:
        raw = raw[:cap]
    # BOM 이 있으면 그 인코딩을 믿는다(메모장의 "유니코드" 저장은 utf-16 LE + BOM).
    encodings = ("utf-8", "cp949")
    for bom, encoding in _BOMS:
        if raw.startswith(bom):
            raw = raw[len(bom):]
            encodings = (encoding,)
            break
    text = None
    for encoding in encodings:
        try:
            # final=False 면 잘린 끝의 반쪽 글자는 버린다(오류로 보지 않는다).
            text = codecs.getincrementaldecoder(encoding)().decode(raw, final=not truncated)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        text = raw.decode(encodings[0], errors="replace")
    return text


# ---------- HTML ----------

# 글이 아닌 것(코드 · 그림 · 숨은 틀)은 통째로 건너뛴다.
_HTML_SKIP = {"script", "style", "noscript", "template", "svg", "math", "iframe", "object", "canvas", "head"}
# 이 태그 앞뒤에서 줄을 바꾼다(문단이 한 줄로 붙지 않게).
_HTML_BLOCK = {
    "address", "article", "aside", "blockquote", "br", "dd", "details", "div", "dl", "dt", "figcaption", "figure",
    "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre",
    "section", "summary", "table", "tr", "ul", "title",
}
_HTML_CELL = {"td", "th"}
# 이 태그 앞뒤에는 빈칸을 둔다(메뉴 · 버튼 글자가 서로 붙지 않게).
_HTML_SPACE = {"a", "button", "label", "option", "img"}
# 닫는 태그가 없는 태그(건너뛰기 깊이를 세지 않는다).
_HTML_VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}


class _HtmlText(html.parser.HTMLParser):
    """HTML 에서 보이는 글자만 모은다. <title> 은 head 안에 있어도 읽는다."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.skip = []  # 건너뛰는 중인 태그들
        self.in_title = False

    def handle_starttag(self, tag, attrs):
        if tag == "title":
            self.in_title = True
            return
        if tag in _HTML_SKIP and tag not in _HTML_VOID:
            self.skip.append(tag)
            return
        if not self.skip:
            self._brk(tag)

    def handle_startendtag(self, tag, attrs):
        if not self.skip:
            self._brk(tag)

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False
            self.parts.append("\n")
            return
        if self.skip and tag in self.skip:
            while self.skip and self.skip.pop() != tag:
                pass
            return
        if not self.skip:
            self._brk(tag)

    def _brk(self, tag):
        if tag in _HTML_BLOCK:
            self.parts.append("\n")
        elif tag in _HTML_CELL:
            self.parts.append("\t")
        elif tag in _HTML_SPACE:
            self.parts.append(" ")

    def handle_data(self, data):
        if self.in_title or not self.skip:
            self.parts.append(data)


def _read_html(path, out):
    if os.path.getsize(path) > MAX_HTML_BYTES:
        raise _TooLarge
    parser = _HtmlText()
    parser.feed(_decode_file(path, MAX_HTML_BYTES))
    parser.close()
    # 줄마다 앞뒤 공백을 접고, 빈 줄이 겹치지 않게 한다.
    lines = []
    for raw in "".join(parser.parts).split("\n"):
        line = re.sub(r"[ \t\r\f\v\u00a0]+", " ", raw).strip()
        if line or (lines and lines[-1]):
            lines.append(line)
    for line in lines:
        out.line(line)


# ---------- PDF ----------


def _read_pdf(path, out):
    from pypdf import PdfReader

    reader = PdfReader(path)
    if reader.is_encrypted:
        try:
            ok = reader.decrypt("")
        except Exception as err:  # noqa: BLE001
            raise _Encrypted from err
        if not ok:
            raise _Encrypted
    seen = 0
    for n, page in enumerate(reader.pages):
        if n >= MAX_PDF_PAGES:
            out.partial = True
            break
        try:
            text = page.extract_text() or ""
        except Exception:  # noqa: BLE001 — 한 쪽이 깨져도 나머지는 읽는다
            text = ""
        seen += len(re.sub(r"\s+", "", text))
        if text.strip():
            out.line(text.strip())
    if seen < MIN_PDF_CHARS:
        return "no_text"
    return None


# ---------- zip 형식 공통 ----------


def _check_zip(zf, names):
    total = 0
    for name in names:
        total += zf.getinfo(name).file_size
        if total > MAX_ZIP_BYTES:
            raise _TooLarge


def _check_parts(path, kind):
    """읽을 XML 항목만 세어 크기 한도를 본다(미디어는 세지 않는다)."""
    pattern = _ZIP_PARTS[kind]
    with zipfile.ZipFile(path) as zf:
        _check_zip(zf, [name for name in zf.namelist() if pattern.match(name)])


# ---------- docx ----------


def _read_docx(path, out):
    _check_parts(path, "docx")
    from docx import Document
    from docx.table import Table

    doc = Document(path)
    for block in doc.iter_inner_content():
        if isinstance(block, Table):
            _docx_table(block, out)
        else:
            out.line(block.text)


def _docx_table(table, out):
    for row in table.rows:
        cells = []
        last = None
        for cell in row.cells:
            if last is not None and cell._tc is last:  # 합친 칸은 한 번만
                continue
            last = cell._tc
            text = cell.text.strip()
            if text:
                cells.append(text)
        if cells:
            out.line(" | ".join(cells))


# ---------- xlsx ----------


def _read_xlsx(path, out):
    _check_parts(path, "xlsx")
    from openpyxl import load_workbook

    wb = load_workbook(path, read_only=True, data_only=True)
    try:
        for ws in wb.worksheets:
            out.line(f"## {ws.title}")
            # 파일이 적어 둔 크기를 믿지 않는다(빈 칸으로 채운 거대한 행을 만들지 않게).
            ws.reset_dimensions()
            for row in ws.iter_rows(values_only=True):
                cells = [str(v).strip() for v in row if v is not None and str(v).strip()]
                if cells:
                    out.line(" | ".join(cells))
            out.add("\n")
    finally:
        wb.close()


# ---------- pptx ----------


def _read_pptx(path, out):
    _check_parts(path, "pptx")
    from pptx import Presentation

    prs = Presentation(path)
    for n, slide in enumerate(prs.slides, start=1):
        out.line(f"## 슬라이드 {n}")
        for shape in slide.shapes:
            _pptx_shape(shape, out)
        if slide.has_notes_slide:
            notes = slide.notes_slide.notes_text_frame
            if notes is not None and notes.text.strip():
                out.line(notes.text.strip())
        out.add("\n")


def _pptx_shape(shape, out):
    if getattr(shape, "shapes", None) is not None and shape.shape_type == 6:  # 그룹
        for child in shape.shapes:
            _pptx_shape(child, out)
        return
    if getattr(shape, "has_text_frame", False) and shape.has_text_frame:
        text = shape.text_frame.text.strip()
        if text:
            out.line(text)
    if getattr(shape, "has_table", False) and shape.has_table:
        for row in shape.table.rows:
            cells = [c.text.strip() for c in row.cells if c.text.strip()]
            if cells:
                out.line(" | ".join(cells))


# ---------- hwpx ----------

_SECTION = re.compile(r"^Contents/section(\d+)\.xml$", re.IGNORECASE)


def _local(tag):
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _read_hwpx(path, out):
    with zipfile.ZipFile(path) as zf:
        sections = sorted(
            (int(m.group(1)), name) for name in zf.namelist() if (m := _SECTION.match(name))
        )
        names = [name for _, name in sections]
        if not names:
            raise KeyError("no section")
        _check_zip(zf, names)
        for name in names:
            with zf.open(name) as f:
                line = []
                for event, elem in ElementTree.iterparse(f, events=("end",)):
                    tag = _local(elem.tag)
                    if tag == "t":
                        line.append("".join(elem.itertext()))
                    elif tag == "p":
                        text = "".join(line).strip()
                        line = []
                        if text:
                            out.line(text)
                        elem.clear()
                text = "".join(line).strip()
                if text:
                    out.line(text)
