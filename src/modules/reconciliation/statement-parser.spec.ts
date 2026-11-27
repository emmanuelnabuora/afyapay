import { DEFAULT_MAPPING, parseAmountToMinor, parseCsv, parseDate, parseStatement } from './statement-parser';

describe('statement parsing', () => {
  it('reads quoted CSV fields, CRLF line ends and a byte-order mark', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"']]);
  });

  it('turns amounts into exact cents without floats', () => {
    expect(parseAmountToMinor('1,500')).toBe(150000n);
    expect(parseAmountToMinor('1500.5')).toBe(150050n);
    expect(parseAmountToMinor('KES 12,345,678.99')).toBe(1234567899n);
    for (const bad of ['', '0', '-100', '1.234', '1,50', 'abc', '1e3']) expect(parseAmountToMinor(bad)).toBeNull();
  });

  it('reads both date formats and refuses impossible dates', () => {
    expect(parseDate('2027-01-31 18:20:00', 'YYYY-MM-DD')).toBe('2027-01-31');
    expect(parseDate('5/2/2027', 'DD/MM/YYYY')).toBe('2027-02-05');
    expect(parseDate('2027-02-30', 'YYYY-MM-DD')).toBeNull();
    expect(parseDate('2027-01-31', 'DD/MM/YYYY')).toBeNull();
  });

  it('maps columns by header, case-insensitive, and reports bad lines with their spreadsheet line number', () => {
    const csv = 'Receipt,Policy_Number,Amount,Date,Extra\nsim1234567,syn-pm-1,"1,000",2027-01-12,x\n,SYN-PM-2,100,2027-01-12,\nSIM7654321,SYN-PM-3,abc,2027-01-12,\n';
    const { lines, missingColumns } = parseStatement(csv, DEFAULT_MAPPING);
    expect(missingColumns).toEqual([]);
    expect(lines[0]).toEqual({ lineNo: 2, ok: true, receipt: 'SIM1234567', policyNumber: 'SYN-PM-1', amountMinor: 100000n, paidOn: '2027-01-12' });
    expect(lines[1]).toMatchObject({ lineNo: 3, ok: false, error: 'M-Pesa receipt is missing or not valid' });
    expect(lines[2]).toMatchObject({ lineNo: 4, ok: false, error: 'Amount is not a positive number' });
  });

  it('names missing columns', () => {
    expect(parseStatement('ref,amount\n', DEFAULT_MAPPING).missingColumns).toEqual(['receipt', 'policy_number', 'date']);
  });
});
