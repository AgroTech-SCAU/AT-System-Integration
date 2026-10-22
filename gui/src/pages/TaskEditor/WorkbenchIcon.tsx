export type WorkbenchIconName='back'|'plus'|'search'|'tree'|'layers'|'focus'|'panels'|'undo'|'redo'|'play'|'check'|'more'|'fit'|'minus'|'close'|'chevron'|'copy'|'trash'|'settings'|'arrow'|'link'
const paths:Record<WorkbenchIconName,string>={
 back:'m14 5-7 7 7 7',plus:'M12 5v14M5 12h14',search:'m16 16 4 4M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13',
 tree:'M12 4v6M5 15v-5h14v5M3 15h4v5H3zM10 2h4v4h-4zM17 15h4v5h-4z',layers:'m12 3 9 5-9 5-9-5 9-5M3 12l9 5 9-5M3 16l9 5 9-5',
 focus:'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',panels:'M3 4h18v16H3zM8 4v16m8-16v16',undo:'M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12',redo:'m15 5 5 5-5 5m5-5H10a6 6 0 0 0 0 12',
 play:'m8 5 11 7-11 7V5',check:'m5 12 4 4L19 6',more:'M5 12h.01M12 12h.01M19 12h.01',fit:'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 8h8v8H8z',minus:'M5 12h14',close:'m6 6 12 12M6 18 18 6',chevron:'m9 5 7 7-7 7',copy:'M8 8h12v12H8zM16 8V4H4v12h4',trash:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',settings:'M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6M9 15v6',arrow:'M5 12h14m-5-5 5 5-5 5',link:'m10 13 4-4M8 15l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 2 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0'
}
export default function WorkbenchIcon({name}:{name:WorkbenchIconName}){return <svg className="bw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>}
