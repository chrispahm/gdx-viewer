'use babel';

import React from 'react';
import ReactDOM from 'react-dom';
import App from './pivot-component';
import {relative} from 'path'
import gdx from 'node-gdx';

export default class GDXViewerView {

  constructor(serializedState, uri) {
    // Create root element
    this.element = document.createElement('div');
    this.element.id = 'gdx-viewer';

    gdx.read(uri).then(data => {
      // here a GUI selector is required which shows the symbols available
      // in the GDX -> take the first symbol for now
      const symbol = Object.keys(data)[0]
      ReactDOM.render(<App data={data[symbol]}/>, this.element);
    }).catch(e => {
      console.log(e);
    })
  }

  getTitle() {
    // Used by Atom for tab text
    return 'GDX Viewer';
  }

  getDefaultLocation() {
    // This location will be used if the user hasn't overridden it by dragging the item elsewhere.
    // Valid values are "left", "right", "bottom", and "center" (the default).
    return 'center';
  }

  getAllowedLocations() {
    // The locations into which the item can be moved.
    return ['center'];
  }

  getURI() {
    // Used by Atom to identify the view when toggling.
    return 'atom://gdx-viewer'
  }

  // Returns an object that can be retrieved when package is activated
  serialize() {
    return {
      deserializer: 'gdx-viewer/GDXViewerView'
    };
  }

  // Tear down any state and detach
  destroy() {
    this.element.remove();
    this.subscriptions.dispose();
  }

  getElement() {
    return this.element;
  }

}
