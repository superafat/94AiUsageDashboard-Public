import { useEffect, useMemo, useRef, useState } from 'react';
import type { PushProducerRecord, UsageSnapshot } from '@94ai/core';
import { resolveResetCredits } from '@94ai/core';
import type { ResetCommandProgress, ResetCommandService, ResetVerifiedInventory } from '@94ai/client';
import { ResetCreditList } from '../components/ResetCreditList';
import { providerFamily } from '../provider-display';

function terminalLabel(progress: ResetCommandProgress | undefined): string | null {
  if (!progress) return null;
  if (progress.status === 'waiting') return '等待 Mac';
  if (progress.status === 'executing') return '執行中';
  if (progress.status === 'unverified') return '無法驗證 Mac 回報';
  if (progress.status === 'uncertain') return '結果不確定，請勿再次使用 Reset 券';
  if (progress.status !== 'terminal' || progress.receipt.type !== 'terminal') return null;
  const { result } = progress.receipt;
  if (result.state === 'unknown' || result.code === 'unknown_outcome' || result.code === 'reconcile_required' || result.code === 'timeout') {
    return '結果不確定，請勿再次使用 Reset 券';
  }
  switch (result.code) {
    case 'reset': return '已確認使用 1 張 Reset 券';
    case 'nothingToReset': return '目前沒有需要重置的額度';
    case 'noCredit': return '目前沒有可用 Reset 券';
    case 'alreadyRedeemed': return '這張 Reset 券已使用';
    case 'credit_expired': return 'Reset 券已過期';
    case 'account_mismatch': return '帳號已變更，未使用 Reset 券';
    default: return result.state === 'failed' ? 'Reset 券未使用成功' : 'Mac 已回報結果';
  }
}

function sameConfirmationSnapshot(a: ResetVerifiedInventory | undefined, b: ResetVerifiedInventory): boolean {
  if (!a || a.status !== 'ready' || b.status !== 'ready') return false;
  return a.pin.backendId === b.pin.backendId
    && a.pin.userId === b.pin.userId
    && a.pin.deviceId === b.pin.deviceId
    && a.pin.publicKey === b.pin.publicKey
    && a.envelope.signature === b.envelope.signature
    && a.envelope.inventory.accountId === b.envelope.inventory.accountId
    && a.credit.creditId === b.credit.creditId
    && a.credit.expiresAt === b.credit.expiresAt;
}

export function ResetCreditsScreen({
  items,
  now = new Date(),
  userId,
  resetCommands,
}: {
  items: UsageSnapshot[];
  now?: Date;
  userId?: string;
  resetCommands?: ResetCommandService | undefined;
}) {
  const codex = items.find((item) => providerFamily(item.providerId) === 'codex');
  const resource = codex?.resources.rateLimitResets;
  const resolved = resolveResetCredits(resource, now);
  const [producers, setProducers] = useState<PushProducerRecord[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [inventory, setInventory] = useState<ResetVerifiedInventory>({ status: 'unavailable' });
  const [pairEpoch, setPairEpoch] = useState(0);
  const [confirmation, setConfirmation] = useState<ResetVerifiedInventory>();
  const [progressByDevice, setProgressByDevice] = useState<Record<string, ResetCommandProgress>>({});
  const [submitting, setSubmitting] = useState(false);
  const [commandError, setCommandError] = useState<string>();
  const resultStops = useRef<Map<string, () => void>>(new Map());

  useEffect(() => () => {
    for (const stop of resultStops.current.values()) stop();
    resultStops.current.clear();
  }, []);

  useEffect(() => {
    if (!resetCommands || !userId) { setProducers([]); return; }
    return resetCommands.subscribeProducers(userId, (next) => {
      setProducers(next);
      setSelectedDeviceId((current) => {
        if (current && next.some((p) => p.deviceId === current)) return current;
        const paired = next.find((p) => resetCommands.getPairing(userId, p.deviceId));
        return paired?.deviceId ?? next[0]?.deviceId ?? '';
      });
    }, () => setCommandError('無法讀取 Mac 配對狀態'));
  }, [resetCommands, userId]);

  const producer = useMemo(
    () => producers.find((item) => item.deviceId === selectedDeviceId),
    [producers, selectedDeviceId],
  );

  const activeInventory: ResetVerifiedInventory = inventory.status === 'ready'
    && producer
    && inventory.pin.deviceId === producer.deviceId
    ? inventory
    : inventory.status === 'ready'
      ? { status: 'unavailable' }
      : inventory;

  useEffect(() => {
    setConfirmation(undefined);
    setCommandError(undefined);
    setInventory({ status: 'unavailable' });
    if (!resetCommands || !userId || !producer) { setInventory({ status: 'unavailable' }); return; }
    if (!resetCommands.getPairing(userId, producer.deviceId)) {
      setInventory({ status: 'unpaired' });
      return;
    }
    return resetCommands.subscribeInventory(userId, producer, setInventory, () => setInventory({ status: 'unverified' }));
  }, [resetCommands, userId, producer, pairEpoch]);

  useEffect(() => {
    if (!confirmation) return;
    if (!sameConfirmationSnapshot(confirmation, activeInventory)) {
      setConfirmation(undefined);
      setCommandError('Reset 券資料已更新，請重新確認');
    }
  }, [confirmation, activeInventory]);

  const handlePair = () => {
    if (!resetCommands || !userId || !producer) return;
    try {
      resetCommands.pair(userId, producer);
      setPairEpoch((value) => value + 1);
    } catch {
      setInventory({ status: 'key_mismatch' });
    }
  };

  const confirmReset = async () => {
    if (!resetCommands || !userId || !producer || inventory.status !== 'ready' || confirmation?.status !== 'ready' || submitting) return;
    if (!sameConfirmationSnapshot(confirmation, activeInventory)) {
      setConfirmation(undefined);
      setCommandError('Reset 券資料已更新，請重新確認');
      return;
    }
    setSubmitting(true);
    setConfirmation(undefined);
    setCommandError(undefined);
    setInventory({ status: 'unavailable' });
    try {
      const request = await resetCommands.dispatch(confirmation);
      setInventory({ status: 'unavailable' });
      const deviceId = request.command.targetDeviceId;
      resultStops.current.get(deviceId)?.();
      const stop = resetCommands.watchResult(userId, producer, request, (next) => {
        setProgressByDevice((current) => ({ ...current, [deviceId]: next }));
      }, () => {
        setProgressByDevice((current) => ({ ...current, [deviceId]: { status: 'uncertain', request } }));
      });
      resultStops.current.set(deviceId, stop);
    } catch {
      setCommandError('無法送出 Reset 指令，沒有使用任何 Reset 券');
    } finally {
      setSubmitting(false);
    }
  };

  const progress = producer ? progressByDevice[producer.deviceId] : undefined;
  const progressLabel = terminalLabel(progress);
  const hasCommandLane = Boolean(resetCommands && userId);
  const paired = Boolean(resetCommands && userId && producer && resetCommands.getPairing(userId, producer.deviceId));

  return <section className="product-screen reset-screen">
    <header className="screen-heading"><div><p className="screen-eyebrow">{codex ? 'Codex' : 'Reset Credits'}</p><h1>重置額度</h1><p>查看免費 Reset Credits 與到期時間。</p></div></header>
    <section className="reset-hero"><span className="reset-hero__icon" aria-hidden="true">↻</span><div><span>目前可用</span><strong>{codex ? resolved.availableCount : 0}</strong><small>{codex ? `張 Reset Credit${resolved.expiredCount > 0 ? `（另有 ${resolved.expiredCount} 張已過期）` : ''}` : '尚無已啟用的來源'}</small></div></section>
    <section className="section"><div className="section-title-row"><div><p className="screen-eyebrow">Read-only</p><h2>可用額度</h2></div></div><ResetCreditList resource={codex ? resource : undefined} now={now} /></section>

    {hasCommandLane ? <section className="section reset-command-panel" aria-label="Reset 安全操作">
      <div className="section-title-row"><div><p className="screen-eyebrow">Paired Mac</p><h2>安全使用 Reset 券</h2></div></div>
      {producers.length > 1 ? <label className="reset-device-select">選擇 Mac<select aria-label="選擇 Mac" value={selectedDeviceId} onChange={(event) => { setSelectedDeviceId(event.target.value); setInventory({ status: 'unavailable' }); setConfirmation(undefined); setCommandError(undefined); }}>{producers.map((item) => <option key={item.deviceId} value={item.deviceId}>{item.deviceId}</option>)}</select></label> : null}
      {producer ? <p className="reset-device-meta">Mac：<strong>{producer.deviceId}</strong></p> : <p className="empty-inline">尚未偵測到可配對的 Mac Companion</p>}
      {producer && !paired ? <button type="button" className="primary-button" onClick={handlePair}>配對這台 Mac</button> : null}
      {activeInventory.status === 'key_mismatch' || activeInventory.status === 'unverified' ? <div className="info-note" role="alert"><strong>無法驗證 Mac 回報</strong><span>裝置金鑰已變更或簽章無法驗證。請重新配對新的 deviceId，不會自動換 key。</span></div> : null}
      {paired && activeInventory.status === 'unavailable' && !progressLabel ? <p className="empty-inline">等待 Mac 更新可用 Reset 券</p> : null}
      {activeInventory.status === 'ready' ? <div className="reset-action-card">
        <p>帳號：<strong>{activeInventory.envelope.inventory.accountId}</strong></p>
        <p>券到期：<strong>{activeInventory.credit.expiresAt ?? '未知'}</strong></p>
        <button type="button" className="primary-button" disabled={submitting} onClick={() => setConfirmation(activeInventory)}>使用 1 張 Reset 券</button>
      </div> : null}
      {progressLabel ? <div className="info-note" role={progress?.status === 'unverified' || progress?.status === 'uncertain' ? 'alert' : 'status'}><strong>{progressLabel}</strong></div> : null}
      {commandError ? <div className="info-note" role="alert"><strong>{commandError}</strong></div> : null}
    </section> : <div className="info-note"><strong>目前僅供查看</strong><span>使用 Reset Credit 屬於不可逆操作，只有已配對且可驗證的 Mac 才能開啟二次確認。</span></div>}

    {confirmation?.status === 'ready' ? <div className="reset-confirm-backdrop" role="presentation">
      <div className="reset-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="reset-confirm-title">
        <h2 id="reset-confirm-title">確認使用 Reset 券</h2>
        <p>Mac：<strong>{confirmation.pin.deviceId}</strong></p>
        <p>帳號：<strong>{confirmation.envelope.inventory.accountId}</strong></p>
        <p>券到期：<strong>{confirmation.credit.expiresAt ?? '未知'}</strong></p>
        <p className="reset-confirm-warning"><strong>這次只會使用 1 張 Reset Credit。</strong>此操作不可逆，不會自動改用其他券。</p>
        <div className="reset-confirm-actions"><button type="button" onClick={() => setConfirmation(undefined)}>取消</button><button type="button" className="primary-button" disabled={submitting} onClick={() => void confirmReset()}>確認使用 1 張 Reset 券</button></div>
      </div>
    </div> : null}
  </section>;
}
