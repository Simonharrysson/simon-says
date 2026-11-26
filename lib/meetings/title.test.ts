import { describe, expect, it } from "vitest";
import { agendaTitle, cleanMeetingTitle, meetingTitle } from "./title";

describe("cleanMeetingTitle", () => {
  it("keeps a short title as it is", () => {
    expect(cleanMeetingTitle("Budget och prova-på-kväll")).toBe("Budget och prova-på-kväll");
  });

  it("drops quotes, a trailing full stop and line breaks", () => {
    expect(cleanMeetingTitle('  "Budget och\nprova-på-kväll."  ')).toBe("Budget och prova-på-kväll");
    expect(cleanMeetingTitle("«Lokalen»")).toBe("Lokalen");
  });

  it("cuts a long answer at eight words and 80 characters", () => {
    expect(cleanMeetingTitle("ett två tre fyra fem sex sju åtta nio tio")).toBe("ett två tre fyra fem sex sju åtta");
    const long = cleanMeetingTitle("Supercalifragilisticexpialidocious ".repeat(3) + "x".repeat(60))!;
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith("…")).toBe(true);
  });

  it("is null for nothing", () => {
    expect(cleanMeetingTitle("")).toBeNull();
    expect(cleanMeetingTitle("  \"\" ")).toBeNull();
    expect(cleanMeetingTitle(undefined)).toBeNull();
    expect(cleanMeetingTitle(42)).toBeNull();
  });
});

describe("agendaTitle", () => {
  it("joins the first two topics in agenda order, leaving out Må-runda and procedure", () => {
    const m = {
      agenda_labels: { "ag-10": "Övrigt", "ag-2": "Ekonomi", "ag-1": "Må-runda", "ag-3": "Spelkväll", "ag-0": "Mötets öppnande" },
      agenda_roles: { "ag-1": "checkin", "ag-0": "procedural", "ag-10": "topic" } as const,
    };
    expect(agendaTitle(m, "och")).toBe("Ekonomi och spelkväll");
    expect(agendaTitle(m, "and")).toBe("Ekonomi and spelkväll");
  });

  it("keeps an abbreviation's capitals", () => {
    expect(agendaTitle({ agenda_labels: { "ag-1": "Budget", "ag-2": "IT-frågor" } }, "och")).toBe("Budget och IT-frågor");
  });

  it("is null without topics", () => {
    expect(agendaTitle({ agenda_labels: { "ag-1": "Må-runda" }, agenda_roles: { "ag-1": "checkin" } }, "och")).toBeNull();
    expect(agendaTitle({}, "och")).toBeNull();
  });
});

describe("meetingTitle", () => {
  const agenda = { agenda_labels: { "ag-1": "Ekonomi" } };

  it("the calendar event wins", () => {
    expect(meetingTitle({ title: "Budget", calendar_event: { title: "Styrelsemöte november" }, ...agenda }, "och")).toBe("Styrelsemöte november");
  });

  it("then the generated title, then the agenda", () => {
    expect(meetingTitle({ title: "Budget och prova-på-kväll", calendar_event: { title: "" }, ...agenda }, "och")).toBe("Budget och prova-på-kväll");
    expect(meetingTitle({ title: null, ...agenda }, "och")).toBe("Ekonomi");
  });

  it("is null for an old meeting without any of them (the date is the main line)", () => {
    expect(meetingTitle({ title: null, calendar_event: null, agenda_labels: {} }, "och")).toBeNull();
  });
});
