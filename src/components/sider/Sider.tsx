import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconPanelLeftOutline16, IconSettingsOutline16, NewChatIcon } from '../base/icons.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import {
  createProject,
  renameProject,
  deleteProject,
  newChat,
  removeSession,
  useChatStore,
} from '../../services/chat/store.js'
import type { Project, SessionSummary } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import styles from './Sider.module.css'

/** 展开的侧边栏：名称与收起按钮、开启新对话、按时间分组的会话列表、底部设置；移动端放在抽屉里，收起按钮关闭抽屉 */
export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const projects = useChatStore((state) => state.projects)
  const newProjectId = useChatStore((state) => state.newProjectId)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [projectDialog, setProjectDialog] = useState<{
    mode: 'create' | 'rename' | 'delete'
    project?: Project
  } | null>(null)
  const [projectName, setProjectName] = useState('')
  const [projectPending, setProjectPending] = useState(false)
  const openProjectDialog = (mode: 'create' | 'rename' | 'delete', project?: Project) => {
    setProjectName(project?.name ?? '')
    setProjectDialog({ mode, project })
  }
  const saveProject = async () => {
    if (!projectDialog || projectPending) {
      return
    }
    setProjectPending(true)
    try {
      if (projectDialog.mode === 'delete' && projectDialog.project) {
        await deleteProject(projectDialog.project.id)
      } else if (projectDialog.mode === 'rename' && projectDialog.project) {
        await renameProject(projectDialog.project.id, projectName)
      } else {
        const project = await createProject(projectName)
        newChat(project.id)
      }
      setProjectDialog(null)
    } catch {
      showToast({ key: 'projectError', type: 'error' })
    } finally {
      setProjectPending(false)
    }
  }
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const groups = useMemo(
    () =>
      groupSessions(
        sessions.filter((s) => !projects.some((p) => p.id === s.projectId)),
        now,
        t
      ),
    [sessions, projects, now, t]
  )
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [deletePending, setDeletePending] = useState(false)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return (
    <div className={clsx(styles.sider, mobile && styles.mobile)}>
      <div className={styles.top}>
        <div className={styles.appName}>{t('appName')}</div>
        <IconButton
          size="m"
          icon={<IconPanelLeftOutline16 />}
          tooltip={t('collapseSiderbarButton')}
          tooltipPlacement="bottom"
          onClick={() => (mobile ? closeMobileSider() : setSiderCollapsed(true))}
        />
      </div>
      <button
        type="button"
        className={styles.newChat}
        onClick={() => {
          newChat()
          closeMobileSider()
        }}
      >
        <span className={styles.newChatIcon}>
          <NewChatIcon />
        </span>
        {t('newChat')}
      </button>
      <div className={styles.listWrap}>
        <div className={styles.list}>
          <div className={styles.section}>
            <div className={styles.projectHeader}>
              <span>{t('projects')}</span>
              <button type="button" onClick={() => openProjectDialog('create')}>
                {t('newProject')}
              </button>
            </div>
            {projects.map((project) => (
              <div key={project.id}>
                <div className={styles.projectRow}>
                  <button
                    type="button"
                    className={styles.projectToggle}
                    aria-expanded={!collapsed.has(project.id)}
                    onClick={() =>
                      setCollapsed((previous) => {
                        const next = new Set(previous)
                        if (next.has(project.id)) {
                          next.delete(project.id)
                        } else {
                          next.add(project.id)
                        }
                        return next
                      })
                    }
                  >
                    <span aria-hidden="true">{collapsed.has(project.id) ? '▸' : '▾'} ▱</span>{' '}
                    {project.name}
                  </button>
                  <button
                    type="button"
                    aria-label={t('newProjectChat', { name: project.name })}
                    title={t('newProjectChat', { name: project.name })}
                    onClick={() => {
                      newChat(project.id)
                      setCollapsed(
                        (previous) => new Set([...previous].filter((id) => id !== project.id))
                      )
                      closeMobileSider()
                    }}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    aria-label={`${t('renameProject')}: ${project.name}`}
                    onClick={() => openProjectDialog('rename', project)}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    aria-label={`${t('deleteProject')}: ${project.name}`}
                    onClick={() => openProjectDialog('delete', project)}
                  >
                    ×
                  </button>
                </div>
                {!collapsed.has(project.id) && (
                  <div className={styles.projectChats}>
                    {sessions
                      .filter((s) => s.projectId === project.id)
                      .map((session) => (
                        <SessionItem
                          key={session.id}
                          session={session}
                          active={session.id === activeId}
                          onDelete={() => setDeleting(session)}
                        />
                      ))}
                    {!sessions.some((s) => s.projectId === project.id) && (
                      <div className={styles.emptyProject}>{t('emptyProject')}</div>
                    )}
                    {activeId === null && newProjectId === project.id && (
                      <div className={styles.emptyProject}>
                        {t('newProjectChat', { name: project.name })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          {groups.map((group) => (
            <div key={group.key} className={styles.section}>
              <div className={styles.sectionHeader}>{group.label}</div>
              {group.sessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === activeId}
                  onDelete={() => setDeleting(session)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className={styles.bottom}>
        <button type="button" className={styles.settings} onClick={() => openSettings('general')}>
          <span className={styles.settingsIcon}>
            <IconSettingsOutline16 />
          </span>
          <span className={styles.settingsLabel}>{t('settings')}</span>
        </button>
      </div>
      {projectDialog && (
        <Modal
          title={t(
            projectDialog.mode === 'create'
              ? 'createProject'
              : projectDialog.mode === 'rename'
                ? 'renameProject'
                : 'deleteProject'
          )}
          onClose={() => {
            if (!projectPending) {
              setProjectDialog(null)
            }
          }}
          footer={
            <>
              <Button
                variant="outlined"
                disabled={projectPending}
                onClick={() => setProjectDialog(null)}
              >
                {t('cancel')}
              </Button>
              <Button
                variant={projectDialog.mode === 'delete' ? 'danger' : undefined}
                disabled={
                  projectPending || (projectDialog.mode !== 'delete' && !projectName.trim())
                }
                onClick={() => void saveProject()}
              >
                {t(projectDialog.mode === 'delete' ? 'delete' : 'saveProject')}
              </Button>
            </>
          }
        >
          {projectDialog.mode === 'delete' ? (
            t('deleteProjectDescription')
          ) : (
            <input
              className={styles.projectInput}
              aria-label={t('projectName')}
              maxLength={100}
              value={projectName}
              autoFocus
              disabled={projectPending}
              onChange={(e) => setProjectName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && projectName.trim()) {
                  void saveProject()
                }
              }}
            />
          )}
        </Modal>
      )}
      {deleting ? (
        <Modal
          title={t('deleteSessionModalContentTitle')}
          onClose={() => {
            if (!deletePending) {
              setDeleting(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={deletePending} onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={async () => {
                  setDeletePending(true)
                  try {
                    if (await removeSession(deleting.id)) {
                      setDeleting(null)
                    } else {
                      showToast({ key: 'sessionDeleteFailed', type: 'error' })
                    }
                  } finally {
                    setDeletePending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionWithFilesDescription')}
        </Modal>
      ) : null}
    </div>
  )
}

/** 移动端抽屉：浮在页面上方，点空白区域关闭。 */
export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  if (!open) {
    return null
  }
  return (
    <>
      <div className={styles.drawerMask} onClick={closeMobileSider} />
      <div className={styles.drawer}>
        <Sider mobile />
      </div>
    </>
  )
}
