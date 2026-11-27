import { Controller, Get } from '@nestjs/common';

/** Normalises a configured value, or null when it is unset or does not look right. */
const phone = (v: string | undefined) => (v && /^\+?[0-9 ]{9,16}$/.test(v.trim()) ? v.trim() : null);
const email = (v: string | undefined) => (v && /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v.trim()) ? v.trim() : null);

/**
 * How customers reach AfyaPay support, from SUPPORT_PHONE and SUPPORT_EMAIL in
 * the host's settings. The app shows only what is set.
 */
@Controller('support')
export class SupportController {
  @Get()
  contact(): { phone: string | null; email: string | null } {
    return { phone: phone(process.env.SUPPORT_PHONE), email: email(process.env.SUPPORT_EMAIL) };
  }
}
