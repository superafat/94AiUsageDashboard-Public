import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BeeMascot } from "./BeeMascot";

describe("BeeMascot component", () => {
  it("renders as decorative inline SVG by default when ariaLabel is not provided", () => {
    const { container } = render(<BeeMascot />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("role")).toBeNull();
  });

  it("renders with accessible name and role=img when ariaLabel is provided", () => {
    render(<BeeMascot ariaLabel="蜂神榜吉祥物" />);
    const img = screen.getByRole("img", { name: "蜂神榜吉祥物" });
    expect(img).toBeInTheDocument();
    expect(img.getAttribute("aria-hidden")).toBeNull();
  });

  it("applies custom size and default dimensions", () => {
    const { container: defaultContainer } = render(<BeeMascot />);
    const defaultSvg = defaultContainer.querySelector("svg");
    expect(defaultSvg?.getAttribute("width")).toBe("28");
    expect(defaultSvg?.getAttribute("height")).toBe("28");

    const { container: customContainer } = render(<BeeMascot size={36} />);
    const customSvg = customContainer.querySelector("svg");
    expect(customSvg?.getAttribute("width")).toBe("36");
    expect(customSvg?.getAttribute("height")).toBe("36");
  });


  it("uses unique internal SVG definition ids when multiple mascots render on the same page", () => {
    const { container } = render(
      <div>
        <BeeMascot />
        <BeeMascot />
      </div>,
    );
    const ids = Array.from(container.querySelectorAll("defs [id]"), (node) => node.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("contains no remote URL assets or external image dependencies", () => {
    const { container } = render(<BeeMascot ariaLabel="吉祥物" />);
    const html = container.innerHTML;
    expect(html).not.toMatch(/https?:\/\//);
    expect(container.querySelectorAll("img, image")).toHaveLength(0);
  });
});
