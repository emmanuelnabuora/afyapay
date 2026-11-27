import { isSyntheticNumber, maskPhone, normaliseKenyanMobile } from './phone';

describe('normaliseKenyanMobile', () => {
  it.each([
    ['0712345678', '+254712345678'],
    ['0712 345 678', '+254712345678'],
    ['712345678', '+254712345678'],
    ['254712345678', '+254712345678'],
    ['+254 712-345-678', '+254712345678'],
    ['0110345678', '+254110345678'],
  ])('accepts %s', (input, expected) => {
    expect(normaliseKenyanMobile(input)).toBe(expected);
  });

  it.each(['', '0212345678', '07123456', '+255712345678', '07123456789', 'abc'])('rejects %s', (input) => {
    expect(normaliseKenyanMobile(input)).toBeNull();
  });

  it('recognises synthetic numbers and masks phones', () => {
    expect(isSyntheticNumber('+254700000123')).toBe(true);
    expect(isSyntheticNumber('+254712345678')).toBe(false);
    expect(maskPhone('+254712345678')).toBe('***678');
  });
});
