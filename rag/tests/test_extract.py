"""extract_text: 형식마다 글 뽑기, 큰 파일 · 깨진 파일이 서버를 죽이지 않는지."""

import zipfile

import pytest

from extract import MAX_ZIP_BYTES, extract_text

# 경로에 공백 · 한글이 있어도 된다(Node 가 주는 실제 경로처럼).
SUBDIR = "첨부 파일 모음"


@pytest.fixture
def d(tmp_path):
    p = tmp_path / SUBDIR
    p.mkdir()
    return p


# ---------- 작은 파일을 테스트 안에서 만든다 ----------


def make_pdf(path, lines, password=None):
    from pypdf import PdfWriter
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    page[NameObject("/Resources")] = DictionaryObject(
        {NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})}
    )
    if lines:
        ops = ["BT", "/F1 12 Tf", "72 720 Td"]
        for line in lines:
            ops.append(f"({line}) Tj")
            ops.append("0 -16 Td")
        ops.append("ET")
        stream = DecodedStreamObject()
        stream.set_data("\n".join(ops).encode("latin-1"))
        page[NameObject("/Contents")] = writer._add_object(stream)
    if password:
        writer.encrypt(user_password=password, owner_password=password)
    with open(path, "wb") as f:
        writer.write(f)
    return path


def make_docx(path):
    from docx import Document

    doc = Document()
    doc.add_paragraph("우주 일지 첫 문단이에요.")
    table = doc.add_table(rows=2, cols=2)
    table.cell(0, 0).text = "이름"
    table.cell(0, 1).text = "값"
    table.cell(1, 0).text = "행성"
    table.cell(1, 1).text = "토성"
    doc.add_paragraph("표 다음 문단.")
    doc.save(path)
    return path


def make_xlsx(path, rows_per_sheet=None):
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "예산"
    ws.append(["항목", "금액"])
    ws.append(["망원경", 120000])
    ws2 = wb.create_sheet("일정")
    ws2.append(["관측", "토요일"])
    if rows_per_sheet:
        for i in range(rows_per_sheet):
            ws2.append([f"행 {i}", "x" * 50])
    wb.save(path)
    return path


def make_pptx(path):
    from pptx import Presentation
    from pptx.util import Inches

    prs = Presentation()
    for title in ("첫 슬라이드 제목", "둘째 슬라이드 제목"):
        slide = prs.slides.add_slide(prs.slide_layouts[5])
        slide.shapes.title.text = title
    box = prs.slides[1].shapes.add_textbox(Inches(1), Inches(2), Inches(4), Inches(1))
    box.text_frame.text = "상자 안 글"
    prs.save(path)
    return path


SECTION_XML = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" '
    'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">'
    "<hp:p><hp:run><hp:t>한글 문서 첫 줄</hp:t></hp:run></hp:p>"
    "<hp:p><hp:run><hp:t>둘째 </hp:t></hp:run><hp:run><hp:t>줄이에요</hp:t></hp:run></hp:p>"
    "</hs:sec>"
)


def make_hwpx(path, sections=None):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("mimetype", "application/hwp+zip")
        for name, xml in (sections or {"Contents/section0.xml": SECTION_XML}).items():
            z.writestr(name, xml)
    return path


# ---------- 형식마다 ----------


def test_txt_utf8(d):
    p = d / "메모 노트.txt"
    p.write_text("안녕하세요 우주\n둘째 줄", encoding="utf-8")
    text, note = extract_text(str(p), "txt")
    assert "안녕하세요 우주" in text
    assert note is None


def test_md_with_bom_and_upper_ext(d):
    p = d / "readme.md"
    p.write_bytes("﻿# 제목\n본문".encode("utf-8"))
    text, note = extract_text(str(p), "MD")
    assert text.startswith("# 제목")
    assert note is None


def test_cp949_txt(d):
    p = d / "옛날 파일.txt"
    p.write_bytes("한글 cp949 문서예요".encode("cp949"))
    text, note = extract_text(str(p), "txt")
    assert "한글 cp949 문서예요" in text
    assert note is None


@pytest.mark.parametrize("ext", ["csv", "json", "log"])
def test_other_text_formats(d, ext):
    p = d / f"data.{ext}"
    p.write_text("값,토성,42", encoding="utf-8")
    text, note = extract_text(str(p), ext)
    assert "토성" in text
    assert note is None


def test_long_text_is_cut_partial(d):
    p = d / "long.txt"
    p.write_text("가" * 200_001, encoding="utf-8")
    text, note = extract_text(str(p), "txt")
    assert len(text) == 200_000
    assert note == "partial"


def test_exact_limit_is_not_partial(d):
    p = d / "exact.txt"
    p.write_text("a" * 200_000, encoding="utf-8")
    text, note = extract_text(str(p), "txt")
    assert len(text) == 200_000
    assert note is None


def test_custom_limit(d):
    p = d / "short.txt"
    p.write_text("abcdef", encoding="utf-8")
    assert extract_text(str(p), "txt", limit=3) == ("abc", "partial")


def test_pdf(d):
    p = make_pdf(d / "관측 보고서.pdf", ["Saturn rings observed tonight", "Second line here"])
    text, note = extract_text(str(p), "pdf")
    assert "Saturn rings observed tonight" in text
    assert note is None


def test_pdf_without_text_is_no_text(d):
    p = make_pdf(d / "scan.pdf", [])
    assert extract_text(str(p), "pdf") == ("", "no_text")


def test_encrypted_pdf_does_not_crash(d):
    p = make_pdf(d / "secret.pdf", ["Top secret text"], password="pw")
    text, note = extract_text(str(p), "pdf")
    assert text == ""
    assert note == "no_text" or note.startswith("error:")
    assert "Top secret" not in (note or "")


def test_docx_paragraphs_and_tables(d):
    p = make_docx(d / "회의 록.docx")
    text, note = extract_text(str(p), "docx")
    assert "우주 일지 첫 문단이에요." in text
    assert "행성 | 토성" in text
    assert text.index("첫 문단") < text.index("토성") < text.index("표 다음 문단")
    assert note is None


def test_broken_docx_is_error(d):
    p = d / "broken.docx"
    p.write_bytes(b"PK\x03\x04 this is not really a docx file")
    text, note = extract_text(str(p), "docx")
    assert text == ""
    assert note.startswith("error:")
    assert "not really" not in note


def test_docx_that_is_a_zip_without_document_is_error(d):
    p = d / "empty-zip.docx"
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("hello.txt", "x")
    text, note = extract_text(str(p), "docx")
    assert text == ""
    assert note.startswith("error:")


def test_xlsx_sheets_and_rows(d):
    p = make_xlsx(d / "가계 부.xlsx")
    text, note = extract_text(str(p), "xlsx")
    assert "## 예산" in text
    assert "항목 | 금액" in text
    assert "망원경 | 120000" in text
    assert "## 일정" in text
    assert "관측 | 토요일" in text
    assert note is None


def test_huge_xlsx_stops_at_limit(d):
    p = make_xlsx(d / "big.xlsx", rows_per_sheet=3000)
    text, note = extract_text(str(p), "xlsx", limit=5000)
    assert len(text) == 5000
    assert note == "partial"


def test_pptx_slides(d):
    p = make_pptx(d / "발표 자료.pptx")
    text, note = extract_text(str(p), "pptx")
    assert "## 슬라이드 1" in text
    assert "첫 슬라이드 제목" in text
    assert "## 슬라이드 2" in text
    assert "상자 안 글" in text
    assert text.index("## 슬라이드 2") < text.index("상자 안 글")
    assert note is None


def test_hwpx_text_nodes(d):
    p = make_hwpx(d / "한글 문서.hwpx")
    text, note = extract_text(str(p), "hwpx")
    assert "한글 문서 첫 줄" in text
    assert "둘째 줄이에요" in text
    assert note is None


def test_hwpx_sections_in_numeric_order(d):
    sec = lambda s: SECTION_XML.replace("한글 문서 첫 줄", s)  # noqa: E731
    p = make_hwpx(
        d / "multi.hwpx",
        {"Contents/section10.xml": sec("열째"), "Contents/section2.xml": sec("둘째구역")},
    )
    text, _ = extract_text(str(p), "hwpx")
    assert text.index("둘째구역") < text.index("열째")


def test_zip_bomb_is_too_large(d, monkeypatch):
    import extract

    monkeypatch.setattr(extract, "MAX_ZIP_BYTES", 10_000)
    p = d / "bomb.hwpx"
    with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("Contents/section0.xml", "<a>" + "0" * 20_000 + "</a>")
    assert extract_text(str(p), "hwpx") == ("", "error:too_large")

    p2 = d / "bomb.docx"
    with zipfile.ZipFile(p2, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("word/document.xml", "0" * 20_000)
    assert extract_text(str(p2), "docx") == ("", "error:too_large")


def test_zip_cap_default_is_50mb():
    assert MAX_ZIP_BYTES == 50 * 1024 * 1024


@pytest.mark.parametrize("ext", ["hwp", "png", "jpg", "zip", "mp4", "exe", ""])
def test_unsupported(d, ext):
    p = d / f"file.{ext or 'noext'}"
    p.write_bytes(b"\x00\x01binary")
    assert extract_text(str(p), ext) == ("", "unsupported")


def test_missing_file_is_error(d):
    text, note = extract_text(str(d / "없는 파일.txt"), "txt")
    assert text == ""
    assert note == "error:missing"


def test_ext_with_dot(d):
    p = d / "a.txt"
    p.write_text("점 붙은 확장자", encoding="utf-8")
    assert extract_text(str(p), ".TXT")[0] == "점 붙은 확장자"
