import { describe, expect, it } from "vitest";
import { isTextType, parseBody } from "../src/util.js";

describe("request bodies", () => {
  it("parses a multipart form the way a browser posts it", () => {
    const boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="title"',
      "",
      "Recorded by the capture script",
      `--${boundary}`,
      'Content-Disposition: form-data; name="content"',
      "",
      "Two lines\r\nof text",
      `--${boundary}`,
      'Content-Disposition: form-data; name="attachment"; filename="shot.png"',
      "Content-Type: image/png",
      "",
      "\x89PNG...",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const ct = `multipart/form-data; boundary=${boundary}`;
    expect(isTextType(ct)).toBe(true);
    expect(parseBody(ct, body).form).toEqual({
      title: "Recorded by the capture script",
      content: "Two lines\r\nof text",
      attachment: "shot.png",
    });
  });

  it("still parses url-encoded and JSON bodies", () => {
    expect(parseBody("application/x-www-form-urlencoded", "a=1&b=x+y").form).toEqual({ a: "1", b: "x y" });
    expect(parseBody("application/json", '{"a":1}').json).toEqual({ a: 1 });
    expect(parseBody("text/plain", "hello")).toEqual({});
  });
});
