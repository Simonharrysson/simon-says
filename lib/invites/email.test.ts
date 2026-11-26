import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defang, escapeHtml, inviteEmail, inviteSubject, linkLikeName, looksLikeLink, oneLine, SUBJECT_MAX } from "./email";

const SAMPLE = { inviterName: "Anna Berg", orgName: "Exempelföreningen", inviteUrl: "https://simonsays.harrysson.co/join/Xk3p9QaZ" };
const file = (name: string) => readFileSync(new URL(`../../emails/invite/${name}`, import.meta.url), "utf8");

describe("inviteEmail (design A)", () => {
  it("renders the reference design exactly (emails/invite/a.html, a.txt)", () => {
    const e = inviteEmail(SAMPLE);
    expect(e.html).toBe(file("a.html"));
    expect(e.text).toBe(file("a.txt"));
  });

  it("subject, preheader and the join link", () => {
    const e = inviteEmail(SAMPLE);
    expect(e.subject).toBe("Anna Berg bjuder in dig till Exempelföreningen på Simon Says");
    expect(e.preheader).toMatch(/^Gå med så kan du starta möten/);
    expect(e.html).toContain('href="https://simonsays.harrysson.co/join/Xk3p9QaZ"');
    expect(e.text).toContain("https://simonsays.harrysson.co/join/Xk3p9QaZ");
    expect(e.text).toContain("Väntade du dig inte mejlet");
    expect(e.html).toContain("Väntade du dig inte mejlet");
  });

  it("escapes every user value in the HTML", () => {
    const e = inviteEmail({ inviterName: `<img src=x onerror="alert(1)">`, orgName: `Kör & "Co" <script>`, inviteUrl: `https://x.test/join/a"b<c` });
    expect(e.html).not.toContain("<img");
    expect(e.html).not.toContain("<script>");
    expect(e.html).toContain("Kör &amp; &quot;Co&quot; &lt;script&gt;");
    expect(e.html).toContain('href="https://x.test/join/a&quot;b&lt;c"');
    expect(e.html).toContain("<title>&lt;img src=x onerror=&quot;alert(1)&quot;&gt; bjuder in dig");
  });

  it("keeps the subject and text on one line per value (no header or line injection)", () => {
    const e = inviteEmail({ inviterName: "Anna\r\nBcc: evil@example.com", orgName: "Org Name\t", inviteUrl: SAMPLE.inviteUrl });
    expect(e.subject).toBe("Anna Bcc: evil@example.\u200ccom bjuder in dig till Org Name på Simon Says");
    expect(e.subject).not.toMatch(/[\r\n]/);
    expect(e.text.split("\n")[0]).toBe("Gå med i Org Name");
  });

  it("refuses a link that is not http(s)", () => {
    expect(() => inviteEmail({ ...SAMPLE, inviteUrl: "javascript:alert(1)" })).toThrow();
  });

  it("helpers", () => {
    expect(oneLine("  a \n\n b\u0000c ")).toBe("a b c");
    expect(escapeHtml(`<a href='x'>&</a>`)).toBe("&lt;a href=&#39;x&#39;&gt;&amp;&lt;/a&gt;");
    expect(inviteSubject("A", "B")).toBe("A bjuder in dig till B på Simon Says");
  });

  it("dots in names get a zero-width non-joiner in subject, text and HTML (no auto-links); the join link stays intact", () => {
    const e = inviteEmail({ inviterName: "A. Berg", orgName: "K.F.U.M Linköping", inviteUrl: "https://simonsays.harrysson.co/join/abc" });
    expect(e.subject).toBe("A.\u200c Berg bjuder in dig till K.\u200cF.\u200cU.\u200cM Linköping på Simon Says");
    expect(e.text).toContain("Gå med i K.\u200cF.\u200cU.\u200cM Linköping");
    expect(e.html).toContain("Gå med i K.\u200cF.\u200cU.\u200cM Linköping</h1>");
    expect(e.html).not.toMatch(/K\.F/);
    expect(e.html).toContain('href="https://simonsays.harrysson.co/join/abc"');
    expect(e.text).toContain("https://simonsays.harrysson.co/join/abc");
    expect(defang(defang("a.b"))).toBe("a.\u200cb");
  });

  it("caps the subject at 80 characters with an ellipsis", () => {
    const s = inviteSubject("Anna Berg", "Föreningen för väldigt långa namn på föreningar i hela Östergötland och Småland");
    expect(s.length).toBeLessThanOrEqual(SUBJECT_MAX);
    expect(s.length).toBeGreaterThan(SUBJECT_MAX - 3);
    expect(s.endsWith("…")).toBe(true);
    expect(inviteSubject("A", "B").length).toBeLessThan(SUBJECT_MAX);
  });
});

describe("looksLikeLink / linkLikeName", () => {
  it("catches domains, URLs, www and addresses", () => {
    for (const s of ["Konto låst – verifiera på bank-login.se", "https://x", "www.exempel", "BANK.COM", "anna@example", "evil.co/x", "ftp://a"]) {
      expect(looksLikeLink(s), s).toBe(true);
    }
  });

  it("lets ordinary förening names through", () => {
    for (const s of ["Exempelföreningen", "K.F.U.M Linköping", "St. Eriks IK", "Golfklubben Tia 2.0", "Hook & Look", "Anna Berg"]) {
      expect(looksLikeLink(s), s).toBe(false);
    }
  });

  it("says which name stops the invite", () => {
    expect(linkLikeName("Anna", "bank-login.se")).toBe("org");
    expect(linkLikeName("anna@x.se", "Föreningen")).toBe("inviter");
    expect(linkLikeName("Anna", "Föreningen")).toBeNull();
  });
});
