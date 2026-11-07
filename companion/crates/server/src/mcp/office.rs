//! Office: the spreadsheets and documents she makes in the Files folders (ADR-73).
//!
//! Pure conversions between what a tool call carries and a file's bytes; `files.rs` decides where
//! a file may go. Spreadsheets are written with `rust_xlsxwriter` and read with `calamine`
//! (`docs/SURFACE.md`, 2026-11-06). A document is a small Markdown subset — `#` to `####`
//! headings, `-` and `1.` lists, `**bold**` and `*italic*` — written as plain WordprocessingML
//! with `zip` and `quick-xml`, and read back as the same Markdown, so an edit is a text edit.
//!
//! Every file she makes carries the custom document property [`MARK`]; `files.rs` refuses to
//! write over a file without it.

use std::collections::HashMap;
use std::io::{Cursor, Read, Write};

use calamine::{Data, Reader};
use quick_xml::Reader as XmlReader;
use quick_xml::XmlVersion;
use quick_xml::events::Event;
use rust_xlsxwriter::{DocProperties, ExcelDateTime, Format, Workbook};
use serde_json::Value;

/// The custom document property on every file she makes, in `docProps/custom.xml`.
pub const MARK: &str = "latentPresence";
const MARK_VALUE: &str = "made by latentPresence";

pub const MAX_SHEETS: usize = 20;
pub const MAX_ROWS: usize = 10_000;
pub const MAX_COLUMNS: usize = 100;
pub const MAX_CELLS: usize = 200_000;
/// Excel's own limit for the text in one cell.
const MAX_CELL_CHARS: usize = 32_767;
/// The longest document she writes, in characters of Markdown.
pub const MAX_DOCUMENT_CHARS: usize = 400_000;
/// What one unzipped part may grow to while reading (a zip bomb costs memory first).
const PART_LIMIT: u64 = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// Spreadsheets

/// How a column's numbers are shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColumnFormat {
    Text,
    Number,
    Money,
    Percent,
    Date,
}

impl ColumnFormat {
    fn parse(name: &str) -> Result<Self, String> {
        match name.trim().to_ascii_lowercase().as_str() {
            "" | "text" | "general" => Ok(Self::Text),
            "number" => Ok(Self::Number),
            "money" | "currency" => Ok(Self::Money),
            "percent" | "percentage" => Ok(Self::Percent),
            "date" => Ok(Self::Date),
            other => Err(format!(
                "\"{other}\" is not a column format; use text, number, money, percent or date."
            )),
        }
    }

    fn format(self) -> Option<Format> {
        match self {
            Self::Text | Self::Number => None,
            Self::Money => Some(Format::new().set_num_format("#,##0.00")),
            Self::Percent => Some(Format::new().set_num_format("0.0%")),
            Self::Date => Some(Format::new().set_num_format("yyyy-mm-dd")),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
    Empty,
    Text(String),
    Number(f64),
    Bool(bool),
    /// Without its leading `=`.
    Formula(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Sheet {
    pub name: String,
    pub rows: Vec<Vec<Cell>>,
    pub formats: Vec<ColumnFormat>,
    /// The first row is a header: bold, and kept in view when scrolling.
    pub header: bool,
}

fn cell(value: &Value) -> Result<Cell, String> {
    match value {
        Value::Null => Ok(Cell::Empty),
        Value::Bool(flag) => Ok(Cell::Bool(*flag)),
        Value::Number(number) => number
            .as_f64()
            .map(Cell::Number)
            .ok_or_else(|| format!("{number} is not a number a spreadsheet can hold.")),
        Value::String(text) => {
            if text.chars().count() > MAX_CELL_CHARS {
                return Err(format!("A cell holds at most {MAX_CELL_CHARS} characters."));
            }
            Ok(match text.strip_prefix('=') {
                Some(formula) if !formula.trim().is_empty() => Cell::Formula(formula.to_owned()),
                _ if text.is_empty() => Cell::Empty,
                _ => Cell::Text(text.clone()),
            })
        }
        Value::Array(_) | Value::Object(_) => {
            Err("A cell is text, a number, true or false, or a formula starting with =.".into())
        }
    }
}

/// The `sheets` argument of `write_spreadsheet`, checked against the limits.
pub fn sheets_from(value: Option<&Value>) -> Result<Vec<Sheet>, String> {
    let list = value
        .and_then(Value::as_array)
        .filter(|list| !list.is_empty())
        .ok_or("Give sheets: a list of {name, rows}, rows being lists of cells.")?;
    if list.len() > MAX_SHEETS {
        return Err(format!(
            "A spreadsheet here has at most {MAX_SHEETS} sheets."
        ));
    }
    let mut cells = 0usize;
    let mut sheets = Vec::with_capacity(list.len());
    for (index, entry) in list.iter().enumerate() {
        let name = entry
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map_or_else(|| format!("Sheet{}", index + 1), str::to_owned);
        let rows_value = entry
            .get("rows")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("Sheet \"{name}\" needs rows: a list of lists of cells."))?;
        if rows_value.len() > MAX_ROWS {
            return Err(format!("A sheet here has at most {MAX_ROWS} rows."));
        }
        let mut rows = Vec::with_capacity(rows_value.len());
        for row in rows_value {
            let row = match row {
                Value::Array(row) => row.as_slice(),
                _ => return Err(format!("Each row of \"{name}\" is a list of cells.")),
            };
            if row.len() > MAX_COLUMNS {
                return Err(format!("A row here has at most {MAX_COLUMNS} cells."));
            }
            cells += row.len();
            if cells > MAX_CELLS {
                return Err(format!("A spreadsheet here has at most {MAX_CELLS} cells."));
            }
            rows.push(row.iter().map(cell).collect::<Result<Vec<_>, _>>()?);
        }
        let formats = match entry.get("formats") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(names)) => names
                .iter()
                .map(|name| ColumnFormat::parse(name.as_str().unwrap_or("")))
                .collect::<Result<Vec<_>, _>>()?,
            Some(_) => return Err("formats is a list of words, one per column.".into()),
        };
        let header = entry.get("header").and_then(Value::as_bool).unwrap_or(true);
        sheets.push(Sheet {
            name,
            rows,
            formats,
            header,
        });
    }
    Ok(sheets)
}

/// An `.xlsx` of these sheets, marked as hers.
pub fn spreadsheet_bytes(sheets: &[Sheet], title: &str) -> Result<Vec<u8>, String> {
    let words =
        |error: rust_xlsxwriter::XlsxError| format!("The spreadsheet could not be made: {error}");
    let mut workbook = Workbook::new();
    workbook.set_properties(
        &DocProperties::new()
            .set_title(title)
            .set_author("latentPresence")
            .set_custom_property(MARK, MARK_VALUE),
    );
    let bold = Format::new().set_bold();
    for sheet in sheets {
        let worksheet = workbook.add_worksheet();
        worksheet
            .set_name(&sheet.name)
            .map_err(|error| format!("\"{}\" cannot name a sheet: {error}", sheet.name))?;
        // LibreOffice shows a formula's stored result until it recalculates; an empty one makes it.
        worksheet.set_formula_result_default("");
        for (r, row) in sheet.rows.iter().enumerate() {
            let row_number = u32::try_from(r).map_err(|_| "Too many rows.".to_owned())?;
            for (c, value) in row.iter().enumerate() {
                let column = u16::try_from(c).map_err(|_| "Too many columns.".to_owned())?;
                let header = sheet.header && r == 0;
                let kind = sheet.formats.get(c).copied().unwrap_or(ColumnFormat::Text);
                let format = if header {
                    Some(bold.clone())
                } else {
                    kind.format()
                };
                match (value, &format) {
                    (Cell::Empty, _) => {}
                    (Cell::Text(text), _) if kind == ColumnFormat::Date && !header => {
                        match ExcelDateTime::parse_from_str(text) {
                            Ok(date) => {
                                let date_format = format.clone().unwrap_or_default();
                                worksheet
                                    .write_datetime_with_format(
                                        row_number,
                                        column,
                                        &date,
                                        &date_format,
                                    )
                                    .map_err(words)?;
                            }
                            Err(_) => {
                                worksheet
                                    .write_string(row_number, column, text)
                                    .map_err(words)?;
                            }
                        }
                    }
                    (Cell::Text(text), Some(format)) => {
                        worksheet
                            .write_string_with_format(row_number, column, text, format)
                            .map_err(words)?;
                    }
                    (Cell::Text(text), None) => {
                        worksheet
                            .write_string(row_number, column, text)
                            .map_err(words)?;
                    }
                    (Cell::Number(number), Some(format)) => {
                        worksheet
                            .write_number_with_format(row_number, column, *number, format)
                            .map_err(words)?;
                    }
                    (Cell::Number(number), None) => {
                        worksheet
                            .write_number(row_number, column, *number)
                            .map_err(words)?;
                    }
                    (Cell::Bool(flag), _) => {
                        worksheet
                            .write_boolean(row_number, column, *flag)
                            .map_err(words)?;
                    }
                    (Cell::Formula(formula), Some(format)) => {
                        worksheet
                            .write_formula_with_format(row_number, column, formula.as_str(), format)
                            .map_err(words)?;
                    }
                    (Cell::Formula(formula), None) => {
                        worksheet
                            .write_formula(row_number, column, formula.as_str())
                            .map_err(words)?;
                    }
                }
            }
        }
        if sheet.header && !sheet.rows.is_empty() {
            worksheet.set_freeze_panes(1, 0).map_err(words)?;
        }
        // Not `autofit()`: it measures a formula by its stored result, which is empty, so a column of
        // totals came out as wide as its heading and showed ### once calculated (R-69, 2026-11-06).
        for (column, width) in column_widths(sheet).into_iter().enumerate() {
            let column = u16::try_from(column).map_err(|_| "Too many columns.".to_owned())?;
            worksheet.set_column_width(column, width).map_err(words)?;
        }
    }
    workbook.save_to_buffer().map_err(words)
}

/// How many characters a number takes in a column's format.
fn number_chars(number: f64, kind: ColumnFormat) -> usize {
    let sign = usize::from(number < 0.0);
    match kind {
        ColumnFormat::Money => {
            let whole = format!("{:.0}", number.abs().trunc()).len();
            sign + whole + (whole - 1) / 3 + 3
        }
        ColumnFormat::Percent => format!("{:.1}%", number * 100.0).len(),
        ColumnFormat::Date => 10,
        ColumnFormat::Text | ColumnFormat::Number => format!("{number}").len(),
    }
}

/// Each column's width in characters: its widest cell, and room for what its formulas will
/// show — two digits more than its widest number, as a total outgrows the items it adds up.
pub fn column_widths(sheet: &Sheet) -> Vec<f64> {
    let columns = sheet.rows.iter().map(Vec::len).max().unwrap_or(0);
    (0..columns)
        .map(|c| {
            let kind = sheet.formats.get(c).copied().unwrap_or(ColumnFormat::Text);
            let mut widest = 0usize;
            let mut numbers = 0usize;
            let mut formulas = false;
            for (r, row) in sheet.rows.iter().enumerate() {
                let chars = match row.get(c) {
                    None | Some(Cell::Empty) => 0,
                    // A bold heading is a little wider than its letters.
                    Some(Cell::Text(text)) if sheet.header && r == 0 => text.chars().count() + 1,
                    Some(Cell::Text(text)) => text.chars().count(),
                    Some(Cell::Bool(_)) => 5,
                    Some(Cell::Number(number)) => {
                        let chars = number_chars(*number, kind);
                        numbers = numbers.max(chars);
                        chars
                    }
                    Some(Cell::Formula(_)) => {
                        formulas = true;
                        0
                    }
                };
                widest = widest.max(chars);
            }
            if formulas {
                widest = widest.max(numbers + 2).max(10);
            }
            (widest as f64 + 2.0).clamp(8.0, 60.0)
        })
        .collect()
}

/// `A`, `B`, … `Z`, `AA`: a column as a spreadsheet names it.
pub fn column_name(mut index: u32) -> String {
    let mut name = Vec::new();
    loop {
        name.push(b'A' + (index % 26) as u8);
        if index < 26 {
            break;
        }
        index = index / 26 - 1;
    }
    name.reverse();
    String::from_utf8(name).unwrap_or_default()
}

fn shown_cell(value: &Data) -> String {
    match value {
        Data::DateTime(date) => date
            .as_datetime()
            .map(|at| {
                if at.time() == chrono::NaiveTime::MIN {
                    at.date().to_string()
                } else {
                    at.to_string()
                }
            })
            .unwrap_or_else(|| value.to_string()),
        other => other.to_string(),
    }
}

/// A sheet as text: its names, then one line per row, `A1: value | B1: =SUM(…)`, from
/// `from_row` (1-based), at most `max_rows` rows. Formulas are shown as formulas, since a file
/// she wrote holds no results until a spreadsheet program calculates them.
pub fn spreadsheet_text(
    bytes: &[u8],
    sheet: &str,
    from_row: usize,
    max_rows: usize,
    max_bytes: usize,
) -> Result<String, String> {
    let mut workbook = calamine::open_workbook_auto_from_rs(Cursor::new(bytes))
        .map_err(|error| format!("could not be read as a spreadsheet: {error}"))?;
    let names = workbook.sheet_names();
    let Some(first) = names.first().cloned() else {
        return Err("has no sheets".into());
    };
    let wanted = if sheet.is_empty() {
        first
    } else {
        names
            .iter()
            .find(|name| name.eq_ignore_ascii_case(sheet))
            .cloned()
            .ok_or_else(|| {
                format!(
                    "has no sheet called \"{sheet}\"; its sheets are {}",
                    names.join(", ")
                )
            })?
    };
    let values = workbook
        .worksheet_range(&wanted)
        .map_err(|error| format!("sheet \"{wanted}\" could not be read: {error}"))?;
    let formulas = workbook.worksheet_formula(&wanted).ok();
    let mut out = format!("Sheets: {}\nSheet \"{wanted}\":\n", names.join(", "));
    let (start, end) = match (
        values.start(),
        values.end(),
        formulas.as_ref().and_then(|f| f.start().zip(f.end())),
    ) {
        (Some(start), Some(end), Some((fstart, fend))) => (
            (start.0.min(fstart.0), start.1.min(fstart.1)),
            (end.0.max(fend.0), end.1.max(fend.1)),
        ),
        (Some(start), Some(end), None) => (start, end),
        (_, _, Some((fstart, fend))) => (fstart, fend),
        _ => {
            out.push_str("(empty)");
            return Ok(out);
        }
    };
    let first_row = u32::try_from(from_row.max(1) - 1)
        .unwrap_or(u32::MAX)
        .max(start.0);
    let mut shown_rows = 0usize;
    let mut row = first_row;
    while row <= end.0 && shown_rows < max_rows && out.len() < max_bytes {
        let mut cells = Vec::new();
        for column in start.1..=end.1 {
            let formula = formulas
                .as_ref()
                .and_then(|f| f.get_value((row, column)))
                .filter(|formula| !formula.is_empty());
            let text = match formula {
                Some(formula) => format!("={formula}"),
                None => values
                    .get_value((row, column))
                    .map(shown_cell)
                    .unwrap_or_default(),
            };
            if !text.is_empty() {
                cells.push(format!("{}{}: {text}", column_name(column), row + 1));
            }
        }
        if !cells.is_empty() {
            out.push_str(&cells.join(" | "));
            out.push('\n');
        }
        shown_rows += 1;
        row += 1;
    }
    if row <= end.0 {
        out.push_str(&format!(
            "[rows {}–{} of {}. Not the whole sheet: read on with from_row {}.]",
            first_row + 1,
            row,
            end.0 + 1,
            row + 1
        ));
    } else {
        out.push_str(&format!("[to row {}: the end of the sheet.]", end.0 + 1));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// Documents

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Block {
    Paragraph,
    /// 0 is the title (`#`), 1–3 the headings below it.
    Heading(u8),
    Bullet,
    Numbered,
}

/// A run of text with its emphasis.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Run {
    text: String,
    bold: bool,
    italic: bool,
}

/// `**bold**` and `*italic*`, each only where it is closed; anything else is the text as written.
fn runs(line: &str) -> Vec<Run> {
    let mut out: Vec<Run> = Vec::new();
    let (mut bold, mut italic) = (false, false);
    let mut current = String::new();
    let mut rest = line;
    let push = |text: &mut String, bold: bool, italic: bool, out: &mut Vec<Run>| {
        if !text.is_empty() {
            out.push(Run {
                text: std::mem::take(text),
                bold,
                italic,
            });
        }
    };
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix("**") {
            if bold || after.contains("**") {
                push(&mut current, bold, italic, &mut out);
                bold = !bold;
                rest = after;
                continue;
            }
        } else if let Some(after) = rest.strip_prefix('*')
            && (italic || after.contains('*'))
        {
            push(&mut current, bold, italic, &mut out);
            italic = !italic;
            rest = after;
            continue;
        }
        let mut chars = rest.chars();
        if let Some(next) = chars.next() {
            current.push(next);
        }
        rest = chars.as_str();
    }
    push(&mut current, bold, italic, &mut out);
    out
}

fn numbered_item(line: &str) -> Option<&str> {
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    if digits == 0 || digits > 4 {
        return None;
    }
    line[digits..].strip_prefix(". ").map(str::trim)
}

/// Markdown lines as blocks; lines of one paragraph are joined with a space.
fn blocks(markdown: &str) -> Vec<(Block, String)> {
    let mut out: Vec<(Block, String)> = Vec::new();
    let mut paragraph: Vec<&str> = Vec::new();
    let flush = |paragraph: &mut Vec<&str>, out: &mut Vec<(Block, String)>| {
        if !paragraph.is_empty() {
            out.push((Block::Paragraph, paragraph.join(" ")));
            paragraph.clear();
        }
    };
    for raw in markdown.lines() {
        let line = raw.trim();
        if line.is_empty() {
            flush(&mut paragraph, &mut out);
            continue;
        }
        let hashes = line.chars().take_while(|c| *c == '#').count();
        let block = if (1..=4).contains(&hashes) && line[hashes..].starts_with(' ') {
            Some((Block::Heading(hashes as u8 - 1), line[hashes..].trim()))
        } else if let Some(item) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")) {
            Some((Block::Bullet, item.trim()))
        } else {
            numbered_item(line).map(|item| (Block::Numbered, item))
        };
        match block {
            Some((kind, text)) => {
                flush(&mut paragraph, &mut out);
                out.push((kind, text.to_owned()));
            }
            None => paragraph.push(line),
        }
    }
    flush(&mut paragraph, &mut out);
    out
}

/// How many paragraphs, headings and list items the Markdown makes.
pub fn paragraphs(markdown: &str) -> usize {
    blocks(markdown).len()
}

/// The document's title: its `#` heading, or `fallback`.
pub fn document_title(markdown: &str, fallback: &str) -> String {
    blocks(markdown)
        .into_iter()
        .find(|(kind, _)| *kind == Block::Heading(0))
        .map(|(_, text)| {
            runs(&text)
                .into_iter()
                .map(|run| run.text)
                .collect::<String>()
        })
        .filter(|title| !title.trim().is_empty())
        .unwrap_or_else(|| fallback.to_owned())
}

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            // Characters XML 1.0 cannot hold at all.
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
            c => out.push(c),
        }
    }
    out
}

const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const HEADER: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#;
/// The numbering instance for bullets; numbered lists get one each from 2, so each starts at 1.
const BULLETS: u32 = 1;

fn document_xml(markdown: &str) -> (String, u32) {
    let mut body = String::new();
    let mut next_list = BULLETS + 1;
    let mut previous = Block::Paragraph;
    for (kind, text) in blocks(markdown) {
        let properties = match kind {
            Block::Paragraph => String::new(),
            Block::Heading(0) => r#"<w:pPr><w:pStyle w:val="Title"/></w:pPr>"#.to_owned(),
            Block::Heading(level) => {
                format!(r#"<w:pPr><w:pStyle w:val="Heading{level}"/></w:pPr>"#)
            }
            Block::Bullet => format!(
                r#"<w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="{BULLETS}"/></w:numPr></w:pPr>"#
            ),
            Block::Numbered => {
                if previous != Block::Numbered {
                    next_list += 1;
                }
                format!(
                    r#"<w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="{}"/></w:numPr></w:pPr>"#,
                    next_list - 1
                )
            }
        };
        previous = kind;
        body.push_str("<w:p>");
        body.push_str(&properties);
        for run in runs(&text) {
            body.push_str("<w:r>");
            if run.bold || run.italic {
                body.push_str("<w:rPr>");
                if run.bold {
                    body.push_str("<w:b/>");
                }
                if run.italic {
                    body.push_str("<w:i/>");
                }
                body.push_str("</w:rPr>");
            }
            body.push_str(&format!(
                r#"<w:t xml:space="preserve">{}</w:t></w:r>"#,
                escape(&run.text)
            ));
        }
        body.push_str("</w:p>");
    }
    let xml = format!(
        r#"{HEADER}<w:document xmlns:w="{W}"><w:body>{body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>"#
    );
    (xml, next_list)
}

fn numbering_xml(lists: u32) -> String {
    let level = |format: &str, text: &str| {
        format!(
            r#"<w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="{format}"/><w:lvlText w:val="{text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>"#
        )
    };
    let mut xml = format!(
        r#"{HEADER}<w:numbering xmlns:w="{W}"><w:abstractNum w:abstractNumId="0">{}</w:abstractNum><w:abstractNum w:abstractNumId="1">{}</w:abstractNum><w:num w:numId="{BULLETS}"><w:abstractNumId w:val="0"/></w:num>"#,
        level("bullet", "•"),
        level("decimal", "%1.")
    );
    for id in BULLETS + 1..lists {
        xml.push_str(&format!(
            r#"<w:num w:numId="{id}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>"#
        ));
    }
    xml.push_str("</w:numbering>");
    xml
}

fn styles_xml() -> String {
    let heading = |id: &str, name: &str, size: u32, level: u32| {
        format!(
            r#"<w:style w:type="paragraph" w:styleId="{id}"><w:name w:val="{name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="320" w:after="80"/><w:outlineLvl w:val="{level}"/></w:pPr><w:rPr><w:b/><w:sz w:val="{size}"/><w:szCs w:val="{size}"/></w:rPr></w:style>"#
        )
    };
    format!(
        r#"{HEADER}<w:styles xmlns:w="{W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:sz w:val="52"/><w:szCs w:val="52"/></w:rPr></w:style>{}{}{}<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style></w:styles>"#,
        heading("Heading1", "heading 1", 32, 0),
        heading("Heading2", "heading 2", 28, 1),
        heading("Heading3", "heading 3", 24, 2),
    )
}

/// A `.docx` of this Markdown, titled and marked as hers.
pub fn document_bytes(markdown: &str, title: &str) -> Result<Vec<u8>, String> {
    let (document, lists) = document_xml(markdown);
    let parts: [(&str, String); 9] = [
        (
            "[Content_Types].xml",
            format!(
                r#"{HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/><Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>"#
            ),
        ),
        (
            "_rels/.rels",
            format!(
                r#"{HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>"#
            ),
        ),
        (
            "word/_rels/document.xml.rels",
            format!(
                r#"{HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>"#
            ),
        ),
        ("word/document.xml", document),
        ("word/styles.xml", styles_xml()),
        ("word/numbering.xml", numbering_xml(lists)),
        (
            "docProps/core.xml",
            format!(
                r#"{HEADER}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>{}</dc:title><dc:creator>latentPresence</dc:creator></cp:coreProperties>"#,
                escape(title)
            ),
        ),
        (
            "docProps/app.xml",
            format!(
                r#"{HEADER}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>latentPresence</Application></Properties>"#
            ),
        ),
        (
            "docProps/custom.xml",
            format!(
                r#"{HEADER}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{{D5CDD505-2E9C-101B-9397-08002B2CF9AE}}" pid="2" name="{MARK}"><vt:lpwstr>{MARK_VALUE}</vt:lpwstr></property></Properties>"#
            ),
        ),
    ];
    let words = |error: zip::result::ZipError| format!("The document could not be made: {error}");
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    for (name, content) in parts {
        writer.start_file(name, options).map_err(words)?;
        writer
            .write_all(content.as_bytes())
            .map_err(|error| format!("The document could not be made: {error}"))?;
    }
    Ok(writer.finish().map_err(words)?.into_inner())
}

fn part(bytes: &[u8], name: &str) -> Result<Option<Vec<u8>>, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("is not a file of this kind: {error}"))?;
    let Ok(entry) = archive.by_name(name) else {
        return Ok(None);
    };
    let mut xml = Vec::new();
    entry
        .take(PART_LIMIT)
        .read_to_end(&mut xml)
        .map_err(|error| format!("could not be unzipped: {error}"))?;
    Ok(Some(xml))
}

fn attribute(element: &quick_xml::events::BytesStart<'_>, key: &str) -> Option<String> {
    element
        .attributes()
        .flatten()
        .find(|attribute| attribute.key.local_name().as_ref() == key)
        .and_then(|attribute| {
            attribute
                .normalized_value(XmlVersion::Implicit1_0)
                .ok()
                .map(|value| value.into_owned())
        })
}

/// Whether she made this file: an `.xlsx` or `.docx` carrying [`MARK`].
pub fn made_by_her(bytes: &[u8]) -> bool {
    let Ok(Some(xml)) = part(bytes, "docProps/custom.xml") else {
        return false;
    };
    let mut reader = XmlReader::from_reader(xml.as_slice());
    let mut buffer = Vec::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(element) | Event::Empty(element))
                if element.local_name().as_ref() == "property"
                    && attribute(&element, "name").as_deref() == Some(MARK) =>
            {
                return true;
            }
            Ok(Event::Eof) | Err(_) => return false,
            Ok(_) => {}
        }
        buffer.clear();
    }
}

/// Which numbering instances are bullets, from `word/numbering.xml`.
fn bullet_lists(bytes: &[u8]) -> HashMap<String, bool> {
    let Ok(Some(xml)) = part(bytes, "word/numbering.xml") else {
        return HashMap::new();
    };
    let mut reader = XmlReader::from_reader(xml.as_slice());
    let mut buffer = Vec::new();
    let mut abstract_bullet: HashMap<String, bool> = HashMap::new();
    let mut instances: HashMap<String, String> = HashMap::new();
    let (mut in_abstract, mut in_num): (Option<String>, Option<String>) = (None, None);
    let mut level_zero = false;
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(element)) => match element.local_name().as_ref() {
                "abstractNum" => in_abstract = attribute(&element, "abstractNumId"),
                "num" => in_num = attribute(&element, "numId"),
                "lvl" => level_zero = attribute(&element, "ilvl").as_deref() == Some("0"),
                _ => {}
            },
            Ok(Event::Empty(element)) => match element.local_name().as_ref() {
                "numFmt" if level_zero => {
                    if let Some(id) = &in_abstract {
                        abstract_bullet.insert(
                            id.clone(),
                            attribute(&element, "val").as_deref() == Some("bullet"),
                        );
                    }
                }
                "abstractNumId" => {
                    if let (Some(num), Some(value)) = (&in_num, attribute(&element, "val")) {
                        instances.insert(num.clone(), value);
                    }
                }
                _ => {}
            },
            Ok(Event::End(element)) => match element.local_name().as_ref() {
                "abstractNum" => in_abstract = None,
                "num" => in_num = None,
                "lvl" => level_zero = false,
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            Ok(_) => {}
        }
        buffer.clear();
    }
    instances
        .into_iter()
        .map(|(num, abstract_id)| {
            (
                num,
                abstract_bullet.get(&abstract_id).copied().unwrap_or(false),
            )
        })
        .collect()
}

fn heading_level(style: &str) -> Option<u8> {
    let lower = style.to_ascii_lowercase().replace(' ', "");
    if lower == "title" {
        return Some(0);
    }
    lower
        .strip_prefix("heading")
        .and_then(|level| level.parse::<u8>().ok())
        .map(|level| level.clamp(1, 3))
}

fn emphasised(runs: &[Run]) -> String {
    // Neighbouring runs with the same emphasis are one, so a word split across runs reads whole.
    let mut merged: Vec<Run> = Vec::new();
    for run in runs {
        match merged.last_mut() {
            Some(last) if last.bold == run.bold && last.italic == run.italic => {
                last.text.push_str(&run.text)
            }
            _ => merged.push(run.clone()),
        }
    }
    merged
        .into_iter()
        .map(|run| {
            let (lead, text, tail) = {
                let trimmed = run.text.trim();
                let start = run.text.len() - run.text.trim_start().len();
                (
                    &run.text[..start],
                    trimmed,
                    &run.text[start + trimmed.len()..],
                )
            };
            if text.is_empty() || !(run.bold || run.italic) {
                return run.text.clone();
            }
            let mark = match (run.bold, run.italic) {
                (true, true) => "***",
                (true, false) => "**",
                _ => "*",
            };
            format!("{lead}{mark}{text}{mark}{tail}")
        })
        .collect()
}

fn toggled(element: &quick_xml::events::BytesStart<'_>) -> bool {
    !matches!(
        attribute(element, "val").as_deref(),
        Some("0" | "false" | "off")
    )
}

/// A `.docx` as Markdown: headings by their styles, lists by their numbering, bold and italic.
/// For one she wrote this is the Markdown she wrote, one line per paragraph.
pub fn document_markdown(bytes: &[u8]) -> Result<String, String> {
    let xml =
        part(bytes, "word/document.xml")?.ok_or("is not a DOCX (it has no word/document.xml)")?;
    let bullets = bullet_lists(bytes);
    let mut reader = XmlReader::from_reader(xml.as_slice());
    let mut buffer = Vec::new();
    let mut lines: Vec<String> = Vec::new();
    let mut runs_now: Vec<Run> = Vec::new();
    let (mut style, mut list): (Option<String>, Option<String>) = (None, None);
    let (mut bold, mut italic, mut in_text, mut in_run_properties) = (false, false, false, false);
    let mut text = String::new();
    let mut previous_list: Option<String> = None;
    let mut number = 0usize;
    loop {
        match reader.read_event_into(&mut buffer) {
            Err(error) => return Err(format!("has XML that could not be read: {error}")),
            Ok(Event::Eof) => break,
            Ok(Event::Start(element)) => match element.local_name().as_ref() {
                "p" => {
                    runs_now.clear();
                    style = None;
                    list = None;
                }
                "r" => {
                    bold = false;
                    italic = false;
                }
                "rPr" => in_run_properties = true,
                "t" => in_text = true,
                _ => {}
            },
            Ok(Event::Empty(element)) => match element.local_name().as_ref() {
                "pStyle" => style = attribute(&element, "val"),
                "numId" => list = attribute(&element, "val").filter(|id| id != "0"),
                "b" if in_run_properties => bold = toggled(&element),
                "i" if in_run_properties => italic = toggled(&element),
                "tab" if !in_run_properties => text.push('\t'),
                "br" | "cr" => text.push(' '),
                _ => {}
            },
            Ok(Event::Text(content)) if in_text => text.push_str(&content.xml10_content()),
            Ok(Event::GeneralRef(reference)) if in_text => match reference.resolve_char_ref() {
                Ok(Some(character)) => text.push(character),
                _ => match reference.xml10_content().as_ref() {
                    "amp" => text.push('&'),
                    "lt" => text.push('<'),
                    "gt" => text.push('>'),
                    "quot" => text.push('"'),
                    "apos" => text.push('\''),
                    _ => {}
                },
            },
            Ok(Event::End(element)) => match element.local_name().as_ref() {
                "t" => in_text = false,
                "rPr" => in_run_properties = false,
                "r" => {
                    if !text.is_empty() {
                        runs_now.push(Run {
                            text: std::mem::take(&mut text),
                            bold,
                            italic,
                        });
                    }
                }
                "p" => {
                    if !text.is_empty() {
                        runs_now.push(Run {
                            text: std::mem::take(&mut text),
                            bold,
                            italic,
                        });
                    }
                    let body = emphasised(&runs_now).trim().to_owned();
                    let level = style.as_deref().and_then(heading_level);
                    let line = match (&list, level) {
                        (Some(id), _) => {
                            if bullets.get(id).copied().unwrap_or(false) {
                                Some(format!("- {body}"))
                            } else {
                                number = if previous_list.as_ref() == Some(id) {
                                    number + 1
                                } else {
                                    1
                                };
                                Some(format!("{number}. {body}"))
                            }
                        }
                        (None, Some(level)) if !body.is_empty() => {
                            Some(format!("{} {body}", "#".repeat(usize::from(level) + 1)))
                        }
                        _ if body.is_empty() => None,
                        _ => Some(body),
                    };
                    previous_list = list.clone();
                    if let Some(line) = line {
                        let is_item = list.is_some();
                        // List items sit together; every other block has a blank line before it.
                        let follows_item = lines.last().is_some_and(|last| {
                            last.starts_with("- ")
                                || last.chars().next().is_some_and(|c| c.is_ascii_digit())
                        });
                        if !lines.is_empty() && !(is_item && follows_item) {
                            lines.push(String::new());
                        }
                        lines.push(line);
                    }
                }
                _ => {}
            },
            Ok(_) => {}
        }
        buffer.clear();
    }
    Ok(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const BUDGET: &str = "# Grocery budget\n\nFor **November**, kept *weekly*.\n\n## Weeks\n\n- Week 1\n- Week 2\n\n## Steps\n\n1. Shop\n2. Cook\n\n### Later\n\n1. Again";

    #[test]
    fn a_document_reads_back_as_the_markdown_she_wrote() {
        let bytes = document_bytes(BUDGET, "Grocery budget").expect("writes");
        assert!(made_by_her(&bytes));
        assert_eq!(document_markdown(&bytes).expect("reads"), BUDGET);
        assert_eq!(document_title(BUDGET, "x"), "Grocery budget");
        // Each numbered list is its own numbering instance, so the second starts at 1 again.
        let numbering =
            String::from_utf8(part(&bytes, "word/numbering.xml").unwrap().unwrap()).unwrap();
        assert!(numbering.contains(r#"w:numId="3""#), "{numbering}");
    }

    #[test]
    fn markup_that_is_not_closed_is_text_and_xml_is_escaped() {
        let markdown = "A 5 * 3 sum & <b>tags</b>, 2. not a list\n1.5 apples";
        let bytes = document_bytes(markdown, "t").expect("writes");
        assert_eq!(
            document_markdown(&bytes).expect("reads"),
            "A 5 * 3 sum & <b>tags</b>, 2. not a list 1.5 apples"
        );
    }

    #[test]
    fn a_document_someone_else_made_reads_by_its_styles_and_is_not_hers() {
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Plan</w:t></w:r></w:p><w:p><w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t xml:space="preserve">Buy </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>milk</w:t></w:r><w:r><w:t xml:space="preserve"> &amp; eggs</w:t></w:r></w:p></w:body></w:document>"#;
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file(
                "word/document.xml",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        writer.write_all(xml.as_bytes()).unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        assert!(!made_by_her(&bytes));
        assert_eq!(
            document_markdown(&bytes).unwrap(),
            "## Plan\n\nBuy **milk** & eggs"
        );
    }

    #[test]
    fn a_spreadsheet_holds_its_values_formats_and_formulas_and_is_hers() {
        let sheets = sheets_from(Some(&json!([{
            "name": "November",
            "formats": ["text", "money", "date"],
            "rows": [["Item", "Budget", "When"], ["Milk", 6.5, "2026-11-02"], ["Bread", 4, null], ["Total", "=SUM(B2:B3)", ""]]
        }])))
        .expect("parses");
        let bytes = spreadsheet_bytes(&sheets, "Groceries").expect("writes");
        assert!(made_by_her(&bytes));
        let text = spreadsheet_text(&bytes, "", 1, 100, 6000).expect("reads");
        assert_eq!(
            text,
            "Sheets: November\nSheet \"November\":\nA1: Item | B1: Budget | C1: When\nA2: Milk | B2: 6.5 | C2: 2026-11-02\nA3: Bread | B3: 4\nA4: Total | B4: =SUM(B2:B3)\n[to row 4: the end of the sheet.]"
        );
        let page = spreadsheet_text(&bytes, "november", 2, 2, 6000).expect("reads a page");
        assert!(
            page.ends_with("[rows 2–3 of 4. Not the whole sheet: read on with from_row 4.]"),
            "{page}"
        );
    }

    #[test]
    fn a_column_of_formulas_is_wide_enough_for_what_they_will_show() {
        // R-69's sheet: "Left" is all formulas, so its heading was its only measure and it showed ###.
        let sheets = sheets_from(Some(&json!([{
            "name": "November 2026",
            "formats": ["text", "money", "money", "money"],
            "rows": [["Item", "Budget", "Spent", "Left"], ["Produce", 120, 0, "=B2-C2"], ["Household & cleaning", 1250.5, 25, "=B3-C3"], ["Total", "=SUM(B2:B3)", "=SUM(C2:C3)", "=B4-C4"]]
        }])))
        .expect("parses");
        let widths = column_widths(&sheets[0]);
        assert_eq!(widths[0], 22.0, "the longest item, 20 characters, and room");
        // "1,250.50" is 8 characters; a total may be two digits wider.
        assert!(
            widths.iter().skip(1).all(|width| *width >= 12.0),
            "{widths:?}"
        );
        assert_eq!(
            number_chars(1_234_567.0, ColumnFormat::Money),
            "1,234,567.00".len()
        );
        assert_eq!(number_chars(-5.0, ColumnFormat::Money), "-5.00".len());
        assert_eq!(number_chars(0.255, ColumnFormat::Percent), "25.5%".len());
    }

    #[test]
    fn spreadsheet_arguments_are_refused_in_words() {
        assert!(sheets_from(None).unwrap_err().contains("Give sheets"));
        assert!(
            sheets_from(Some(&json!([{ "rows": [[{ "a": 1 }]] }])))
                .unwrap_err()
                .contains("A cell is")
        );
        assert!(
            sheets_from(Some(&json!([{ "rows": [], "formats": ["fancy"] }])))
                .unwrap_err()
                .contains("not a column format")
        );
        let wide: Vec<Value> = (0..=MAX_COLUMNS).map(|n| json!(n)).collect();
        assert!(
            sheets_from(Some(&json!([{ "rows": [wide] }])))
                .unwrap_err()
                .contains("at most")
        );
        let bad = sheets_from(Some(&json!([{ "name": "a/b", "rows": [] }]))).unwrap();
        assert!(
            spreadsheet_bytes(&bad, "t")
                .unwrap_err()
                .contains("cannot name a sheet")
        );
        assert_eq!(column_name(0), "A");
        assert_eq!(column_name(25), "Z");
        assert_eq!(column_name(26), "AA");
        assert_eq!(column_name(701), "ZZ");
    }
}
