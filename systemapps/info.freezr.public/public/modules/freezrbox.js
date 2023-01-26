// freezrBox.js
import { dg } from './dgelements.js'

const makeBox = function (params = { imgSrc: null, mainTextHTML: null, bottomButt: null, imgFunc: null, mainTextFunc: null, maintextLink: null, bottomButtFunc: null }) {
  const { imgSrc, imgFunc, mainTextFunc, mainTextHTML } = params // , bottomButt, bottomButtFunc

  return dg.div(
    {
      style: {
        width: '100px',
        'min-height': '150px',
        padding: '10px',
        margin: '10px',
        cursor: (mainTextFunc ? 'pointer' : 'default'),
        'text-align': 'center',
        'border-radius': '5px',
        'background-color': '#E2E2E2' // '#c3c3c3'
      }
    },
    imgSrc // add logo or image if exists
      ? dg.div(
        { style: { padding: '10px', width: '80px', height: '80px', 'max-height': '80px', 'min-height': '80px', 'text-align': 'center', overflow: 'hidden' } },
        dg.img({
          width: '80',
          style: { cursor: 'pointer' },
          src: imgSrc,
          onclick: imgFunc
        })
      )
      : dg.br(),

    mainTextHTML // add main text below
      ? dg.div(
        { style: { color: 'blue', opacity: '1.0', 'font-size': '16px' }, onclick: mainTextFunc },
        mainTextHTML
      )
      : null
  )
}

export { makeBox }
