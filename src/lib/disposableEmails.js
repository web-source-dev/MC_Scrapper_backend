/** Common disposable / temporary inbox domains. Also matched as suffixes (foo.mailinator.com). */
export const DISPOSABLE_EMAIL_DOMAINS = [
  "0-mail.com",
  "027168.com",
  "10minemail.com",
  "10minutemail.com",
  "10minutemail.de",
  "10minutemail.net",
  "10minutemail.org",
  "1secmail.com",
  "1secmail.net",
  "1secmail.org",
  "20minutemail.com",
  "2prong.com",
  "33mail.com",
  "anonbox.net",
  "anonymbox.com",
  "bouncr.com",
  "burnermail.io",
  "byebyemail.com",
  "cool.fr.nf",
  "correo.blogos.net",
  "courriel.fr.nf",
  "crazymailing.com",
  "dayrep.com",
  "deadaddress.com",
  "discard.email",
  "discarded.email",
  "dispostable.com",
  "dodgeit.com",
  "dodgit.com",
  "dontreg.com",
  "dropmail.me",
  "dumpmail.de",
  "e4ward.com",
  "easytrashmail.com",
  "emailfake.com",
  "emailnator.com",
  "emailondeck.com",
  "emailtemporario.com.br",
  "fakeinbox.com",
  "fakemail.fr",
  "fakemailgenerator.com",
  "filzmail.com",
  "getairmail.com",
  "getnada.com",
  "gishpuppy.com",
  "gmailnator.com",
  "grr.la",
  "guerrillamail.biz",
  "guerrillamail.com",
  "guerrillamail.de",
  "guerrillamail.info",
  "guerrillamail.net",
  "guerrillamail.org",
  "guerrillamailblock.com",
  "haltospam.com",
  "harakirimail.com",
  "hidemail.de",
  "inboxbear.com",
  "inboxkitten.com",
  "inboxproxy.com",
  "incognitomail.org",
  "instant-mail.de",
  "jetable.org",
  "jourrapide.com",
  "kasmail.com",
  "throwawaymail.com",
  "mail-temporaire.fr",
  "mail.catch.com",
  "mail.tm",
  "mailbidon.com",
  "mailcatch.com",
  "maildrop.cc",
  "mailinator.com",
  "mailinator.net",
  "mailinator.org",
  "mailinator2.com",
  "mailnesia.com",
  "mailnull.com",
  "mailsac.com",
  "mailscrap.com",
  "mailtemp.info",
  "mailtothis.com",
  "meltmail.com",
  "mintemail.com",
  "mohmal.com",
  "mytemp.email",
  "nada.email",
  "notmailinator.com",
  "nowmymail.com",
  "pokemail.net",
  "pookmail.com",
  "privacy-mail.xyz",
  "sharklasers.com",
  "sneakemail.com",
  "spam4.me",
  "spambog.com",
  "spambox.us",
  "spamfree24.org",
  "spamgourmet.com",
  "spamhole.com",
  "spaml.de",
  "temp-mail.org",
  "temp-mail.ru",
  "tempail.com",
  "tempemail.com",
  "tempemail.net",
  "tempinbox.com",
  "tempmail.cn",
  "tempmail.com",
  "tempmail.de",
  "tempmail.ninja",
  "tempmailo.com",
  "tempr.email",
  "throwaway.email",
  "tmail.ws",
  "tmails.net",
  "tmpmail.net",
  "tmpmail.org",
  "trash-mail.com",
  "trashmail.com",
  "trashmailer.com",
  "trashymail.com",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
  "yopmail.org",
  "you-spam.com",
  "generator.email",
  "gettempmail.com",
  "mail.gw",
  "mailforspam.com",
  "minuteinbox.com",
  "moakt.com",
  "mytrashmail.com",
  "temp-mail.io",
  "tempmail.plus",
  "throwam.com",
];

const DISPOSABLE_SET = new Set(DISPOSABLE_EMAIL_DOMAINS);

const RESERVED_DOMAINS = new Set([
  "example.com",
  "example.net",
  "example.org",
  "example.edu",
  "test.com",
  "test.net",
  "test.org",
  "invalid.com",
  "localhost",
  "localdomain",
]);

const RESERVED_TLDS = new Set(["test", "example", "invalid", "localhost", "local", "internal", "lan", "home", "corp"]);

const DISPOSABLE_NAME =
  /(^|\.)(temp-?mail|tmpmail|trash-?mail|fakeinbox|throwaway|guerrilla|mailinator|yopmail|10minutemail|minutemail|mailnesia|maildrop|disposable|burnermail|getnada|inboxkitten|spam4me)(\.|$)/i;

function hostLabels(domain) {
  const host = String(domain || "")
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "");
  if (!host || !host.includes(".")) return [];
  return host.split(".").filter(Boolean);
}

export function isDisposableEmailDomain(domain) {
  const labels = hostLabels(domain);
  if (labels.length < 2) return false;
  const host = labels.join(".");
  for (let i = 0; i < labels.length - 1; i += 1) {
    if (DISPOSABLE_SET.has(labels.slice(i).join("."))) return true;
  }
  return DISPOSABLE_NAME.test(host);
}

export function isReservedEmailDomain(domain) {
  const labels = hostLabels(domain);
  if (labels.length < 2) return true;
  if (RESERVED_TLDS.has(labels[labels.length - 1])) return true;
  for (let i = 0; i < labels.length - 1; i += 1) {
    if (RESERVED_DOMAINS.has(labels.slice(i).join("."))) return true;
  }
  return false;
}

export function isBlockedSignupDomain(domain) {
  return isReservedEmailDomain(domain) || isDisposableEmailDomain(domain);
}
