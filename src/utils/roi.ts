/** Currency choices of the ROI calculator, with the deal values offered in each. */
export const CURRENCIES = [
  {
    code: "USD",
    flag: "🇺🇸",
    symbol: "$",
    deals: [1000, 2500, 5000, 10000, 25000],
  },
  {
    code: "SGD",
    flag: "🇸🇬",
    symbol: "S$",
    deals: [1000, 2500, 5000, 10000, 25000],
  },
  {
    code: "HKD",
    flag: "🇭🇰",
    symbol: "HK$",
    deals: [5000, 10000, 25000, 50000, 100000],
  },
  {
    code: "AUD",
    flag: "🇦🇺",
    symbol: "A$",
    deals: [1000, 2500, 5000, 10000, 25000],
  },
  {
    code: "THB",
    flag: "🇹🇭",
    symbol: "฿",
    deals: [25000, 50000, 100000, 250000, 500000],
  },
];

export type Currency = (typeof CURRENCIES)[number];

type Option = { value: number; label: string; tag?: string };

export const VISITOR_OPTIONS: Option[] = [
  { value: 1000, label: "1,000", tag: "Early stage" },
  { value: 2500, label: "2,500", tag: "Growing" },
  { value: 5000, label: "5,000", tag: "Established" },
  { value: 10000, label: "10,000", tag: "Strong" },
  { value: 25000, label: "25,000", tag: "High traffic" },
];

export const CONVERSION_OPTIONS: Option[] = [
  { value: 0.5, label: "0.5%", tag: "Very low" },
  { value: 1, label: "1.0%", tag: "Below average" },
  { value: 2, label: "2.0%", tag: "Average" },
  { value: 3, label: "3.0%", tag: "Good" },
  { value: 5, label: "5.0%", tag: "High performing" },
  { value: 7.5, label: "7.5%", tag: "Excellent" },
  { value: 10, label: "10.0%", tag: "Exceptional" },
];

export const CLOSE_OPTIONS: Option[] = [
  { value: 5, label: "5%", tag: "Very low" },
  { value: 10, label: "10%", tag: "Low" },
  { value: 20, label: "20%", tag: "Average" },
  { value: 30, label: "30%", tag: "Strong" },
  { value: 40, label: "40%", tag: "Very strong" },
  { value: 50, label: "50%", tag: "Excellent" },
  { value: 60, label: "60%", tag: "Exceptional" },
  { value: 70, label: "70%", tag: "Elite" },
];

/** Deal values offered for a currency, labelled with its symbol. */
export const dealOptions = (currency: Currency): Option[] =>
  currency.deals.map((value) => ({
    value,
    label: formatMoney(value, currency.symbol),
  }));

/** Lift of each improvement, applied one after another. */
export const LIFTS = {
  conversion: 0.25,
  search: 0.15,
  qualification: 0.1,
  trust: 0.1,
};

type Inputs = {
  /** Average deal value. */
  deal: number;
  /** Monthly website visitors. */
  visitors: number;
  /** Visitor-to-lead rate, in percent. */
  conversion: number;
  /** Lead-to-deal rate, in percent. */
  close: number;
};

/**
 * Annual revenue today and after the four improvements, compounding:
 * conversion rate, then traffic, then close rate, then deal value.
 */
export const calculate = ({ deal, visitors, conversion, close }: Inputs) => {
  const leads = visitors * (conversion / 100);
  const deals = leads * (close / 100);
  const current = deals * deal * 12;

  const afterConversion = current * (1 + LIFTS.conversion);
  const afterSearch = afterConversion * (1 + LIFTS.search);
  const afterQualification = afterSearch * (1 + LIFTS.qualification);
  const next = afterQualification * (1 + LIFTS.trust);

  const leadLift = (1 + LIFTS.conversion) * (1 + LIFTS.search);
  const dealLift = leadLift * (1 + LIFTS.qualification);

  return {
    current,
    next,
    gain: next - current,
    extraLeads: leads * (leadLift - 1),
    extraDeals: deals * (dealLift - 1) * 12,
    steps: {
      conversion: afterConversion - current,
      search: afterSearch - afterConversion,
      qualification: afterQualification - afterSearch,
      trust: next - afterQualification,
    },
  };
};

/** Whole amount with thousands separators: `$1,181,250`. */
export const formatMoney = (value: number, symbol: string) =>
  `${symbol}${Math.round(value).toLocaleString("en-US")}`;

/** Amount shortened to thousands or millions: `$12.0M`. */
export const formatShort = (value: number, symbol: string) => {
  if (value >= 1e6) return `${symbol}${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${symbol}${(value / 1e3).toFixed(1)}K`;
  return formatMoney(value, symbol);
};
