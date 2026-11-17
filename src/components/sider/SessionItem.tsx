import clsx from 'clsx'
import { memo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconEditOutline16, IconEllipsisOutline16, IconTrashOutline16 } from '../base/icons.js'
import {
  moveSession,
  renameSession,
  selectSession,
  useChatStore,
} from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { IconButton } from '../base/IconButton.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { Menu } from '../base/Menu.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionItem.module.css'

export const SessionItem = memo(function SessionItem({
  session,
  active,
  onDelete,
}: {
  session: SessionSummary
  active: boolean
  onDelete: () => void
}) {
  const t = useTranslate()
  const projects = useChatStore((state) => state.projects)
  const [moving, setMoving] = useState(false)
  const [target, setTarget] = useState('')
  const [pending, setPending] = useState(false)
  const [editing, setEditing] = useState(false)
  const displayTitle = session.title || t('untitledChat')

  if (editing) {
    const finish = (title: string) => {
      setEditing(false)
      if (title.trim() && title.trim() !== displayTitle) {
        renameSession(session.id, title.trim())
      }
    }
    return (
      <input
        className={styles.renameInput}
        defaultValue={displayTitle}
        autoFocus
        onFocus={(event) => event.target.select()}
        onBlur={(event) => finish(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            finish(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <>
      <div
        className={clsx(styles.item, active && styles.active)}
        onClick={() => {
          selectSession(session.id)
          closeMobileSider()
        }}
      >
        <div className={styles.title}>{displayTitle}</div>
        <div className={styles.action} onClick={(event) => event.stopPropagation()}>
          <Menu
            options={[
              {
                key: 'rename',
                label: t('sessionItemMenuRenameOption'),
                icon: <IconEditOutline16 />,
                onSelect: () => setEditing(true),
              },
              {
                key: 'move',
                icon: <span aria-hidden="true">▱</span>,
                label: t('moveToProject'),
                onSelect: () => {
                  setTarget(
                    projects.some((p) => p.id === session.projectId)
                      ? (session.projectId ?? '')
                      : ''
                  )
                  setMoving(true)
                },
              },
              {
                key: 'delete',
                label: t('delete'),
                icon: <IconTrashOutline16 />,
                danger: true,
                onSelect: onDelete,
              },
            ]}
          >
            {({ toggle }) => (
              <IconButton
                icon={<IconEllipsisOutline16 />}
                aria-label={t('more')}
                onClick={toggle}
              />
            )}
          </Menu>
        </div>
      </div>
      {moving && (
        <Modal
          title={t('moveToProject')}
          onClose={() => {
            if (!pending) {
              setMoving(false)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={pending} onClick={() => setMoving(false)}>
                {t('cancel')}
              </Button>
              <Button
                disabled={pending}
                onClick={async () => {
                  setPending(true)
                  try {
                    await moveSession(session.id, target || null)
                    setMoving(false)
                  } catch {
                    showToast({ key: 'projectError', type: 'error' })
                  } finally {
                    setPending(false)
                  }
                }}
              >
                {t('moveChat')}
              </Button>
            </>
          }
        >
          <select
            aria-label={t('moveToProject')}
            value={target}
            disabled={pending}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">{t('noProject')}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Modal>
      )}
    </>
  )
})
