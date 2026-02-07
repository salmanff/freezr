// freezrBox.js
import { dg } from './dgelements.js'

const makeBox = function (params = { imgSrc: null, mainTextHTML: null, bottomButt: null, imgFunc: null, mainTextFunc: null, maintextLink: null, bottomButtFunc: null }) {
  const { imgSrc, imgFunc, mainTextFunc, mainTextHTML } = params // , bottomButt, bottomButtFunc

  // Use the same styling as freezrBox cards on the home page
  return dg.div(
    {
      className: 'freezrBox',
      style: {
        cursor: (mainTextFunc ? 'pointer' : 'default')
      }
    },
    imgSrc // add logo or image if exists
      ? dg.div(
        { className: 'fBoxImgOuter' },
        dg.img({
          className: 'fBoxImg',
          src: imgSrc,
          onclick: imgFunc
        })
      )
      : dg.div({ className: 'fBoxImgOuter' }), // empty placeholder for consistent layout

    mainTextHTML // add main text below
      ? dg.div(
        { 
          className: 'fBoxText',
          onclick: mainTextFunc 
        },
        mainTextHTML
      )
      : null
  )
}

export { makeBox }
