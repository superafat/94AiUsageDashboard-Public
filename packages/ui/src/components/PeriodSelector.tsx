import type { UsagePeriod } from '@94ai/core';

const OPTIONS: Array<{ value: UsagePeriod; label: string }> = [
  { value: '1d', label: '今日' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
];

export function PeriodSelector({ value, onChange }: { value: UsagePeriod; onChange: (value: UsagePeriod) => void }) {
  return <div className="period-selector" role="group" aria-label="統計期間">
    {OPTIONS.map((option) => <button key={option.value} type="button" data-active={value === option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}
