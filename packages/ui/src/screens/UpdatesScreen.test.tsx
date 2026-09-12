import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UpdatesScreen } from "./UpdatesScreen";

describe("UpdatesScreen component", () => {
  it("renders semantic heading, current version 0.1.4, and release date", () => {
    const onNavigate = vi.fn();
    render(<UpdatesScreen onNavigate={onNavigate} />);

    expect(screen.getByRole("heading", { level: 1, name: "更新與公告" })).toBeInTheDocument();
    expect(screen.getByText(/0\.1\.4/)).toBeInTheDocument();
    expect(screen.getByText(/推播辨識與品牌體驗更新/)).toBeInTheDocument();
    expect(screen.getByText("目前開發版本")).toBeInTheDocument();
    expect(screen.queryByText("目前版本")).not.toBeInTheDocument();
  });

  it("renders release highlights without raw HTML injection", () => {
    const onNavigate = vi.fn();
    const { container } = render(<UpdatesScreen onNavigate={onNavigate} />);

    const articles = container.querySelectorAll("article");
    expect(articles.length).toBeGreaterThan(0);
    expect(screen.getByText(/蜂神榜/)).toBeInTheDocument();
  });

  it("provides back navigation button targeting settings or previous screen", () => {
    const onNavigate = vi.fn();
    render(<UpdatesScreen onNavigate={onNavigate} />);

    const backButton = screen.getByRole("button", { name: /返回設定|返回/ });
    expect(backButton).toBeInTheDocument();
    fireEvent.click(backButton);
    expect(onNavigate).toHaveBeenCalledWith({ route: "settings" });
  });
});
