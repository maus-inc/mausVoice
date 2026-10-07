import { describe, expect, it } from "vitest";
import {
  isSpokenNumberWord,
  normalizeSpokenForms,
} from "./inverse-text-normalization.utils";

describe("normalizeSpokenForms", () => {
  it("leaves text with no spoken forms untouched", () => {
    const samples = [
      "",
      "hello there",
      "I need one",
      "chapter five",
      "send the file as it is",
      "我需要二十五",
      "Call me at 3:30 PM",
      "the first of the month",
      "a pound of coffee",
    ];
    for (const sample of samples) {
      expect(normalizeSpokenForms(sample)).toBe(sample);
    }
  });

  it("leaves year-shaped and malformed runs as words", () => {
    const samples = [
      "in nineteen eighty four",
      "twenty twenty",
      "one two three",
      "nineteen ninety nine",
      "chapter six sixteen",
      "one two",
    ];
    for (const sample of samples) {
      expect(normalizeSpokenForms(sample)).toBe(sample);
    }
  });

  it("writes cardinal numbers through a scale word", () => {
    expect(normalizeSpokenForms("we need one hundred units")).toBe(
      "we need 100 units",
    );
    expect(normalizeSpokenForms("one hundred and fifty")).toBe("150");
    expect(normalizeSpokenForms("two thousand five hundred seats")).toBe(
      "2,500 seats",
    );
    expect(normalizeSpokenForms("a million people")).toBe("1,000,000 people");
  });

  it("writes bare cardinals only from twenty up", () => {
    expect(normalizeSpokenForms("thirty")).toBe("30");
    expect(normalizeSpokenForms("twenty three boxes")).toBe("23 boxes");
    expect(normalizeSpokenForms("twenty-three boxes")).toBe("23 boxes");
    expect(normalizeSpokenForms("fifteen")).toBe("fifteen");
    expect(normalizeSpokenForms("ten")).toBe("ten");
  });

  it("drops the article in front of a scale word", () => {
    expect(normalizeSpokenForms("about a hundred people")).toBe(
      "about 100 people",
    );
    expect(normalizeSpokenForms("a thousand times")).toBe("1,000 times");
    expect(normalizeSpokenForms("I need a twenty")).toBe("I need 20");
  });

  it("writes currency", () => {
    expect(
      normalizeSpokenForms("we need two hundred and fifty thousand dollars"),
    ).toBe("we need $250,000");
    expect(normalizeSpokenForms("five dollars")).toBe("$5");
    expect(normalizeSpokenForms("twenty five bucks")).toBe("$25");
    expect(normalizeSpokenForms("thirty euros")).toBe("€30");
  });

  it("keeps a comma that separates two numbers, and one that groups digits", () => {
    expect(normalizeSpokenForms("we sold twenty, three of them")).toBe(
      "we sold 20, three of them",
    );
    expect(
      normalizeSpokenForms("one thousand, two hundred and thirty four"),
    ).toBe("1,234");
    expect(
      normalizeSpokenForms("the total is one thousand, two hundred and fifty."),
    ).toBe("the total is 1,250.");
  });

  it("writes percentages", () => {
    expect(normalizeSpokenForms("fifty percent")).toBe("50%");
    expect(normalizeSpokenForms("one hundred percent")).toBe("100%");
    expect(normalizeSpokenForms("forty five per cent")).toBe("45%");
    expect(normalizeSpokenForms("twenty three percent.")).toBe("23%.");
    // "per cent" carries its punctuation on the second word.
    expect(normalizeSpokenForms("forty five per cent.")).toBe("45%.");
  });

  it("writes times with a meridiem", () => {
    expect(normalizeSpokenForms("meet at three thirty pm")).toBe(
      "meet at 3:30 PM",
    );
    expect(normalizeSpokenForms("call at nine am")).toBe("call at 9 AM");
    expect(normalizeSpokenForms("standup at three oh five pm")).toBe(
      "standup at 3:05 PM",
    );
    expect(normalizeSpokenForms("the window is three to five pm")).toBe(
      "the window is 3 to 5 PM",
    );
  });

  it("writes times from a time preposition and o'clock forms", () => {
    expect(normalizeSpokenForms("meet at three thirty")).toBe("meet at 3:30");
    expect(normalizeSpokenForms("by eleven forty five")).toBe("by 11:45");
    expect(normalizeSpokenForms("nine o'clock")).toBe("9:00");
    expect(normalizeSpokenForms("quarter past three")).toBe("3:15");
    expect(normalizeSpokenForms("half past three")).toBe("3:30");
    expect(normalizeSpokenForms("quarter to four")).toBe("3:45");
  });

  it("does not read a bare hour and minute as a time without a preposition", () => {
    const samples = [
      "three thirty",
      "the score was twenty thirty",
      "eleven forty five",
    ];
    for (const sample of samples) {
      expect(normalizeSpokenForms(sample)).toBe(sample);
    }
  });

  it("writes dates", () => {
    expect(normalizeSpokenForms("ship on the twenty third of october")).toBe(
      "ship on October 23",
    );
    expect(normalizeSpokenForms("ship on october twenty third")).toBe(
      "ship on October 23",
    );
    expect(normalizeSpokenForms("due on the third of march")).toBe(
      "due on March 3",
    );
    expect(normalizeSpokenForms("due on the thirty first of december")).toBe(
      "due on December 31",
    );
    // The "of <month>" shape writes a date even for an ambiguous month word.
    expect(normalizeSpokenForms("due on the third of march")).toBe(
      "due on March 3",
    );
  });

  it("keeps the modal and verb senses of month names", () => {
    for (const sample of [
      "we march first thing in the morning",
      "you may first want to check the logs",
      "the august first edition",
    ]) {
      expect(normalizeSpokenForms(sample)).toBe(sample);
    }
  });

  it("writes a number that ends the sentence", () => {
    expect(normalizeSpokenForms("we ordered twenty three.")).toBe(
      "we ordered 23.",
    );
    expect(normalizeSpokenForms("the total is two hundred and fifty.")).toBe(
      "the total is 250.",
    );
    expect(normalizeSpokenForms("we sold five million.")).toBe(
      "we sold 5,000,000.",
    );
  });

  it("ends a number run at the sentence boundary", () => {
    expect(
      normalizeSpokenForms("we sold one thousand. Twenty five arrived late"),
    ).toBe("we sold 1,000. 25 arrived late");
    expect(
      normalizeSpokenForms("we ordered twenty three. Five more came"),
    ).toBe("we ordered 23. Five more came");
  });

  it("leaves a decimal in words", () => {
    // "zero point five percent" used to come back half-written as
    // "zero point 5%", and the tail of a decimal is not a quantity on its own.
    for (const sample of [
      "zero point five percent",
      "the point twenty five",
      "two point five million",
      "three point one four",
    ]) {
      expect(normalizeSpokenForms(sample)).toBe(sample);
    }
  });

  it("leaves an attributive currency name alone", () => {
    // A singular currency name in front of a noun names a kind of thing, not an
    // amount, so the number in front of it is not a quantity.
    for (const sample of [
      "the million dollar question",
      "a hundred dollar bill",
      "the thousand dollar question",
    ]) {
      expect(normalizeSpokenForms(sample)).toBe(sample);
    }
    // With a count in it, the number is written, and the article stays because
    // the currency name is not a unit here.
    expect(normalizeSpokenForms("a five dollar bill")).toBe("a $5 bill");
    expect(normalizeSpokenForms("twenty dollar bills")).toBe("$20 bills");
    expect(normalizeSpokenForms("it costs twenty thousand euro")).toBe(
      "it costs €20,000",
    );
  });

  it("knows its own number words", () => {
    expect(isSpokenNumberWord("twenty")).toBe(true);
    expect(isSpokenNumberWord("Twenty")).toBe(true);
    expect(isSpokenNumberWord("million")).toBe(true);
    expect(isSpokenNumberWord("report")).toBe(false);
  });

  it("keeps the rest of the sentence exactly as it was", () => {
    expect(
      normalizeSpokenForms(
        "so um I need to send the report by friday no wait thursday",
      ),
    ).toBe("so um I need to send the report by friday no wait thursday");
    expect(
      normalizeSpokenForms("we have twenty five units in the warehouse"),
    ).toBe("we have 25 units in the warehouse");
  });
});
