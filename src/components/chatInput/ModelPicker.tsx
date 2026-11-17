import { useEffect, useId, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { useSettings, setModel, setReasoningEffort } from '../../services/settings.js'
import type { ChatModel, ReasoningEffort } from '../../services/api/types.js'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import { IconCheckOutline16, IconChevronDownOutline14 } from '../base/icons.js'
import './ModelPicker.css'

const models: { value: ChatModel; label: string }[] = [
  { value: 'deepseek-flash', label: 'DeepSeek Flash' },
  { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
]
export const ModelPicker = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const id = useId()
  const model = useSettings((s) => s.model)
  const thinking = useSettings((s) => s.thinking)
  const effort = useSettings((s) => s.reasoningEffort)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'main' | 'model' | 'effort'>('main')
  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(open, {
    side: 'top',
    align: 'end',
    offset: 6,
    measureKey: view,
  })
  const close = () => {
    setOpen(false)
    anchorRef.current?.focus()
  }
  useDismiss(open, [anchorRef, floatingRef], close, { captureEscape: true })
  useEffect(() => {
    if (open) {
      const menu = floatingRef.current
      const selected = menu?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
      ;(selected ?? menu?.querySelector<HTMLButtonElement>('button'))?.focus()
    }
  }, [open, view, floatingRef])
  useEffect(() => {
    if (disabled) {
      setOpen(false)
    }
  }, [disabled])
  const efforts: { value: ReasoningEffort | 'off'; label: string }[] = [
    { value: 'off', label: t('effortOff') },
    { value: 'low', label: t('effortLow') },
    { value: 'high', label: t('effortHigh') },
    { value: 'max', label: t('effortMax') },
  ]
  const selectedEffort = thinking ? effort : 'off'
  const effortLabel = efforts.find((item) => item.value === selectedEffort)?.label
  const modelLabel = models.find((item) => item.value === model)?.label
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      return
    }
    event.preventDefault()
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'))
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next]?.focus()
  }
  return (
    <div className="model-picker">
      <button
        ref={anchorRef}
        className="model-picker-trigger"
        type="button"
        aria-label={t('modelPicker')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => {
          setView('main')
          setOpen(!open)
        }}
      >
        <span>{modelLabel}</span>
        <span className="model-picker-effort">{effortLabel}</span>
        <IconChevronDownOutline14 />
      </button>
      {open &&
        !disabled &&
        createPortal(
          <div
            ref={floatingRef}
            id={id}
            className="model-picker-menu"
            role="menu"
            aria-label={t(
              view === 'main' ? 'modelPicker' : view === 'model' ? 'modelLabel' : 'effortLabel'
            )}
            style={position ?? undefined}
            onKeyDown={keyboard}
          >
            {view === 'main' ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="model-picker-row"
                  onClick={() => setView('model')}
                >
                  <span>{t('modelLabel')}</span>
                  <span className="model-picker-value">
                    {modelLabel}
                    <span aria-hidden>›</span>
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="model-picker-row"
                  onClick={() => setView('effort')}
                >
                  <span>{t('effortLabel')}</span>
                  <span className="model-picker-value">
                    {effortLabel}
                    <span aria-hidden>›</span>
                  </span>
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="model-picker-back"
                  onClick={() => setView('main')}
                >
                  ‹ {t('pickerBack')}
                </button>
                {view === 'model'
                  ? models.map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        role="menuitemradio"
                        aria-checked={model === item.value}
                        className="model-picker-option"
                        onClick={() => {
                          setModel(item.value)
                          close()
                        }}
                      >
                        <span>
                          <span>{item.label}</span>
                          <small>
                            {t(
                              item.value === 'deepseek-flash'
                                ? 'modelFlashDescription'
                                : 'modelProDescription'
                            )}
                          </small>
                        </span>
                        {model === item.value && <IconCheckOutline16 />}
                      </button>
                    ))
                  : efforts.map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        role="menuitemradio"
                        aria-checked={selectedEffort === item.value}
                        className="model-picker-option"
                        onClick={() => {
                          setReasoningEffort(item.value)
                          close()
                        }}
                      >
                        <span>{item.label}</span>
                        {selectedEffort === item.value && <IconCheckOutline16 />}
                      </button>
                    ))}
              </>
            )}
          </div>,
          document.body
        )}
    </div>
  )
}
