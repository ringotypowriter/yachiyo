/**
 * Fullscreen image viewer overlay.
 *
 * Supports wheel-zoom, click-drag pan, fit-to-screen reset, and
 * "Reveal in Finder" for asset-scheme images. Follows the same
 * portal + fixed overlay pattern as LinkSafetyModal and ConfirmDialog.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FolderOpen, Maximize2, RotateCw, X, ZoomIn, ZoomOut } from 'lucide-react'
import { extractLocalPath } from './imageUrl'

interface ImageDetailViewerProps {
  src: string
  alt?: string
  isOpen: boolean
  onClose: () => void
}

const MIN_ZOOM = 0.1
const MAX_ZOOM = 10
const ZOOM_STEP = 1.15

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 200,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(0, 0, 0, 0.7)',
  cursor: 'default'
}

const toolbarStyle: React.CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  display: 'flex',
  gap: 4,
  padding: 4,
  borderRadius: 10,
  background: 'rgba(0, 0, 0, 0.45)',
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)'
}

const toolbarBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 32,
  height: 32,
  borderRadius: 7,
  border: 'none',
  background: 'transparent',
  color: 'rgba(255, 255, 255, 0.85)',
  cursor: 'pointer',
  transition: 'background 120ms ease'
}

const toolbarBtnHover: React.CSSProperties = {
  background: 'rgba(255, 255, 255, 0.12)'
}

function ToolbarButton({
  onClick,
  label,
  children
}: {
  onClick: () => void
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      type="button"
      style={{ ...toolbarBtnStyle, ...(hovered ? toolbarBtnHover : {}) }}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={label}
    >
      {children}
    </button>
  )
}

const altLabelStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 12,
  left: '50%',
  transform: 'translateX(-50%)',
  maxWidth: '60%',
  padding: '6px 14px',
  borderRadius: 8,
  background: 'rgba(0, 0, 0, 0.45)',
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
  color: 'rgba(255, 255, 255, 0.85)',
  fontSize: 12,
  textAlign: 'center',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  pointerEvents: 'none'
}

const separatorStyle: React.CSSProperties = {
  width: 1,
  height: 20,
  background: 'rgba(255, 255, 255, 0.15)',
  margin: '6px 2px'
}

export function ImageDetailViewer({ isOpen, ...rest }: ImageDetailViewerProps): React.ReactNode {
  // Mounting the body component only when open means useState
  // initializers fire fresh each time — no reset effect needed.
  if (!isOpen) return null
  return createPortal(<ImageDetailViewerBody {...rest} />, document.body)
}

function ImageDetailViewerBody({
  src,
  alt,
  onClose
}: Omit<ImageDetailViewerProps, 'isOpen'>): React.JSX.Element {
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [rotation, setRotation] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const dragRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null)

  // Escape key.
  useEffect(() => {
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  // Wheel zoom.
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    setZoom((z) => {
      const next = e.deltaY < 0 ? z * ZOOM_STEP : z / ZOOM_STEP
      return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next))
    })
  }, [])

  // Drag to pan.
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return
      const target = e.target as HTMLElement
      if (target.closest('[data-toolbar]')) return
      e.preventDefault()
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      dragRef.current = { startX: e.clientX, startY: e.clientY, ox: offset.x, oy: offset.y }
      setIsDragging(true)
    },
    [offset]
  )

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return
    const dx = e.clientX - dragRef.current.startX
    const dy = e.clientY - dragRef.current.startY
    setOffset({ x: dragRef.current.ox + dx, y: dragRef.current.oy + dy })
  }, [])

  const handlePointerUp = useCallback(() => {
    dragRef.current = null
    setIsDragging(false)
  }, [])

  // Double-click: toggle between fit and 100%.
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('[data-toolbar]')) return
      if (Math.abs(zoom - 1) < 0.01) {
        setZoom(2)
      } else {
        setZoom(1)
        setOffset({ x: 0, y: 0 })
      }
    },
    [zoom]
  )

  const handleZoomIn = useCallback(() => {
    setZoom((z) => Math.min(MAX_ZOOM, z * ZOOM_STEP))
  }, [])
  const handleZoomOut = useCallback(() => {
    setZoom((z) => Math.max(MIN_ZOOM, z / ZOOM_STEP))
  }, [])
  const handleReset = useCallback(() => {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
    setRotation(0)
  }, [])
  const handleRotateCw = useCallback(() => {
    setRotation((r) => (r + 90) % 360)
  }, [])

  const localPath = extractLocalPath(src)
  const handleReveal = useCallback(() => {
    if (!localPath) return
    window.api?.yachiyo?.revealFile?.({ path: localPath })
  }, [localPath])

  // Backdrop click closes — but NOT when the click started as a drag.
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('[data-toolbar]') || target.closest('[data-image]')) return
      onClose()
    },
    [onClose]
  )

  const showAlt = alt?.trim()

  return (
    <div
      style={overlayStyle}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onClick={handleBackdropClick}
      onDoubleClick={handleDoubleClick}
    >
      <img
        data-image
        src={src}
        alt={alt ?? ''}
        draggable={false}
        style={{
          maxWidth: '90vw',
          maxHeight: '90vh',
          objectFit: 'contain',
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom}) rotate(${rotation}deg)`,
          transformOrigin: 'center center',
          transition: isDragging ? 'none' : 'transform 120ms ease-out',
          borderRadius: 6,
          cursor: zoom > 1 ? 'grab' : 'zoom-in',
          userSelect: 'none'
        }}
      />

      {/* Toolbar */}
      <div data-toolbar style={toolbarStyle}>
        <ToolbarButton onClick={handleZoomIn} label="Zoom in">
          <ZoomIn size={16} />
        </ToolbarButton>
        <ToolbarButton onClick={handleZoomOut} label="Zoom out">
          <ZoomOut size={16} />
        </ToolbarButton>
        <ToolbarButton onClick={handleReset} label="Fit to screen">
          <Maximize2 size={16} />
        </ToolbarButton>
        <ToolbarButton onClick={handleRotateCw} label="Rotate clockwise">
          <RotateCw size={16} />
        </ToolbarButton>
        {localPath ? (
          <ToolbarButton onClick={handleReveal} label="Reveal in Finder">
            <FolderOpen size={16} />
          </ToolbarButton>
        ) : null}
        <div style={separatorStyle} />
        <ToolbarButton onClick={onClose} label="Close">
          <X size={16} />
        </ToolbarButton>
      </div>

      {showAlt ? <div style={altLabelStyle}>{showAlt}</div> : null}
    </div>
  )
}
