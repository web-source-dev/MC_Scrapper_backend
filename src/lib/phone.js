/** ITU calling codes. Longest prefix match wins. */
const CALLING_CODES = new Set([
  "1",
  "7",
  "20",
  "27",
  "30",
  "31",
  "32",
  "33",
  "34",
  "36",
  "39",
  "40",
  "41",
  "43",
  "44",
  "45",
  "46",
  "47",
  "48",
  "49",
  "51",
  "52",
  "53",
  "54",
  "55",
  "56",
  "57",
  "58",
  "60",
  "61",
  "62",
  "63",
  "64",
  "65",
  "66",
  "81",
  "82",
  "84",
  "86",
  "90",
  "91",
  "92",
  "93",
  "94",
  "95",
  "98",
  "211",
  "212",
  "213",
  "216",
  "218",
  "220",
  "221",
  "222",
  "223",
  "224",
  "225",
  "226",
  "227",
  "228",
  "229",
  "230",
  "231",
  "232",
  "233",
  "234",
  "235",
  "236",
  "237",
  "238",
  "239",
  "240",
  "241",
  "242",
  "243",
  "244",
  "245",
  "246",
  "248",
  "249",
  "250",
  "251",
  "252",
  "253",
  "254",
  "255",
  "256",
  "257",
  "258",
  "260",
  "261",
  "262",
  "263",
  "264",
  "265",
  "266",
  "267",
  "268",
  "269",
  "290",
  "291",
  "297",
  "298",
  "299",
  "350",
  "351",
  "352",
  "353",
  "354",
  "355",
  "356",
  "357",
  "358",
  "359",
  "370",
  "371",
  "372",
  "373",
  "374",
  "375",
  "376",
  "377",
  "378",
  "380",
  "381",
  "382",
  "383",
  "385",
  "386",
  "387",
  "389",
  "420",
  "421",
  "423",
  "500",
  "501",
  "502",
  "503",
  "504",
  "505",
  "506",
  "507",
  "508",
  "509",
  "590",
  "591",
  "592",
  "593",
  "594",
  "595",
  "596",
  "597",
  "598",
  "599",
  "670",
  "672",
  "673",
  "674",
  "675",
  "676",
  "677",
  "678",
  "679",
  "680",
  "681",
  "682",
  "683",
  "685",
  "686",
  "687",
  "688",
  "689",
  "690",
  "691",
  "692",
  "850",
  "852",
  "853",
  "855",
  "856",
  "880",
  "886",
  "960",
  "961",
  "962",
  "963",
  "964",
  "965",
  "966",
  "967",
  "968",
  "970",
  "971",
  "972",
  "973",
  "974",
  "975",
  "976",
  "977",
  "992",
  "993",
  "994",
  "995",
  "996",
  "998",
]);

/** National number length [min, max] for common desk countries. Others use 7–12. */
const NATIONAL_LENGTH = {
  1: [10, 10],
  7: [10, 10],
  33: [9, 9],
  44: [10, 10],
  49: [10, 11],
  52: [10, 10],
  55: [10, 11],
  61: [9, 9],
  63: [10, 10],
  81: [10, 10],
  86: [11, 11],
  90: [10, 10],
  91: [10, 10],
  92: [9, 10],
  234: [10, 10],
  254: [9, 9],
  880: [10, 10],
  966: [9, 9],
  971: [9, 9],
};

const REPEATED = /^(\d)\1+$/;
const SEQUENTIAL = new Set(["1234567890", "0123456789", "9876543210", "123456789", "987654321"]);

function callingCode(digits) {
  for (let size = 3; size >= 1; size -= 1) {
    const code = digits.slice(0, size);
    if (CALLING_CODES.has(code)) return code;
  }
  return null;
}

function nanpLooksFake(national) {
  const npa = national.slice(0, 3);
  const nxx = national.slice(3, 6);
  if (!/^[2-9]\d{2}$/.test(npa) || /^[2-9]11$/.test(npa)) return true;
  if (!/^[2-9]\d{2}$/.test(nxx)) return true;
  if (nxx === "555") return true;
  return false;
}

function parsePhone(value) {
  const raw = String(value || "").trim();
  if (!raw) return { error: "Enter a phone number" };
  if (/[A-Za-z]/.test(raw)) return { error: "Use digits, spaces, +, dashes, or parentheses" };
  if ((raw.match(/\+/g) || []).length > 1) return { error: "Start with + and your country code, like +1 or +92" };

  const intlPrefix = raw.startsWith("+") || raw.startsWith("00");
  if (!intlPrefix) {
    return { error: "Start with + and your country code, like +1 or +92" };
  }

  let digits = raw.replace(/\D/g, "");
  if (raw.startsWith("00")) digits = digits.replace(/^00/, "");
  if (!digits || digits.startsWith("0") || digits.length < 8 || digits.length > 15) {
    return { error: "Enter a valid phone number with country code" };
  }

  const cc = callingCode(digits);
  if (!cc) return { error: "Enter a valid country code, like +1 or +92" };

  const national = digits.slice(cc.length);
  const [minLen, maxLen] = NATIONAL_LENGTH[cc] || [7, 12];
  if (national.length < minLen || national.length > maxLen) {
    return { error: "That phone number doesn't look right" };
  }
  if (REPEATED.test(digits) || REPEATED.test(national) || SEQUENTIAL.has(national) || SEQUENTIAL.has(digits)) {
    return { error: "Enter a real phone number" };
  }
  if (cc === "1" && nanpLooksFake(national)) {
    return { error: "Enter a real phone number" };
  }
  if (/^0/.test(national) && cc !== "39") {
    return { error: "Drop the leading 0 after the country code" };
  }
  return { e164: `+${digits}`, cc, national };
}

export function phoneError(value) {
  return parsePhone(value).error || null;
}

export function normalizePhone(value) {
  const parsed = parsePhone(value);
  return parsed.e164 || "";
}
