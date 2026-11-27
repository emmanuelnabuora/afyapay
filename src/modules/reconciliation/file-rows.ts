import { HttpException, HttpStatus } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { parseCsv } from './statement-parser';

export interface UploadedFile {
  originalname: string;
  buffer: Buffer;
}

const fail = (code: string, message: string) => new HttpException({ code, message }, HttpStatus.UNPROCESSABLE_ENTITY);

const two = (n: number) => String(n).padStart(2, '0');

/** A spreadsheet cell as the text a person would see, dates in the given format. */
function cellText(value: ExcelJS.CellValue, dateFormat: 'YYYY-MM-DD' | 'DD/MM/YYYY'): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    // Excel stores dates without a zone; exceljs reads them as UTC.
    const [y, m, d] = [value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate()];
    return dateFormat === 'DD/MM/YYYY' ? `${two(d)}/${two(m)}/${y}` : `${y}-${two(m)}-${two(d)}`;
  }
  if (typeof value === 'object') {
    if ('result' in value && value.result !== undefined) return cellText(value.result as ExcelJS.CellValue, dateFormat); // formula
    if ('richText' in value) return value.richText.map((t) => t.text).join('');
    if ('text' in value) return String(value.text); // hyperlink
    return '';
  }
  return String(value);
}

/**
 * Reads a CSV or Excel (.xlsx) upload into rows of text. Excel: the first
 * worksheet only. Formulas give their saved result.
 */
export async function readRows(file: UploadedFile | undefined, dateFormat: 'YYYY-MM-DD' | 'DD/MM/YYYY' = 'YYYY-MM-DD'): Promise<{ rows: string[][]; kind: 'csv' | 'xlsx' }> {
  if (!file?.buffer?.length) throw fail('file.required', 'Attach the file.');
  const name = file.originalname || '';
  if (/\.csv$/i.test(name)) return { rows: parseCsv(file.buffer.toString('utf8')), kind: 'csv' };
  if (/\.xlsx$/i.test(name)) {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(file.buffer as unknown as ArrayBuffer);
    } catch {
      throw fail('file.unreadable', 'This Excel file could not be read. Save it again as .xlsx or CSV.');
    }
    const sheet = wb.worksheets[0];
    if (!sheet) throw fail('file.empty', 'The Excel file has no worksheet.');
    const rows: string[][] = [];
    const width = sheet.columnCount;
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      for (let c = 1; c <= width; c++) cells.push(cellText(row.getCell(c).value, dateFormat));
      rows.push(cells);
    });
    return { rows, kind: 'xlsx' };
  }
  throw fail('file.type', 'Upload a CSV or Excel (.xlsx) file. Send PDF statements to manual review.');
}
