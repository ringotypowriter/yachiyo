export function buildBrowserAnnotationScript(token: string): string {
  return `(() => {
      globalThis.__yachiyoCancelAnnotation?.()
      const overlay = document.createElement('div')
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;touch-action:none'
      const selection = document.createElement('div')
      selection.style.cssText = 'position:absolute;border:2px solid #f05252;background:rgb(240 82 82 / .12);pointer-events:none;display:none;box-sizing:border-box'
      overlay.append(selection); document.documentElement.append(overlay)
      let start
      const cleanup = () => { overlay.remove(); document.removeEventListener('keydown',cancel,true); globalThis.__yachiyoCancelAnnotation = undefined }
      const cancel = event => {if(event.key === 'Escape') { event.preventDefault(); cleanup() }}
      overlay.onpointerdown = event => {
        event.preventDefault(); event.stopImmediatePropagation()
        start = {x:event.clientX,y:event.clientY}
        overlay.setPointerCapture(event.pointerId)
      }
      overlay.onpointermove = event => {
        if (!start) return
        Object.assign(selection.style,{display:'block',left:Math.min(start.x,event.clientX)+'px',top:Math.min(start.y,event.clientY)+'px',width:Math.abs(start.x-event.clientX)+'px',height:Math.abs(start.y-event.clientY)+'px'})
      }
      overlay.onpointerup = event => {
        if (!start) return
        event.preventDefault();event.stopImmediatePropagation()
        const width = Math.abs(start.x-event.clientX), height = Math.abs(start.y-event.clientY)
        overlay.style.display='none'
        const node = document.elementFromPoint(event.clientX,event.clientY) || document.body
        const rect = node.getBoundingClientRect()
        const region = width > 6 || height > 6
        const annotation = region
          ? {text:'Page area',x:Math.min(start.x,event.clientX),y:Math.min(start.y,event.clientY),width,height}
          : {text:(node.innerText || node.getAttribute('aria-label') || node.tagName).slice(0,500),selector:node.id ? '#' + CSS.escape(node.id) : undefined,x:rect.x,y:rect.y,width:rect.width,height:rect.height}
        console.debug(${JSON.stringify(token)}, JSON.stringify(annotation))
        const stopClick = event => {event.preventDefault();event.stopImmediatePropagation()}
        document.addEventListener('click',stopClick,{capture:true,once:true})
        setTimeout(()=>document.removeEventListener('click',stopClick,true),0)
        cleanup()
      }
      globalThis.__yachiyoCancelAnnotation = cleanup
      document.addEventListener('keydown',cancel,true)
    })()`
}
