'use babel';

import GDXViewerView from './gdx-viewer-view';
import { CompositeDisposable, Disposable } from 'atom';
import {extname} from 'path'

export default {

  subscriptions: null,

  activate(state) {
    this.subscriptions = new CompositeDisposable(
      // Add an opener for our view.
      atom.workspace.addOpener(uri => {
        const ext = extname(uri)
        if (ext === '.gdx') {
          return new GDXViewerView(null,uri);
        }
      }),

      // Destroy any GDXViewerViews when the package is deactivated.
      new Disposable(() => {
        atom.workspace.getPaneItems().forEach(item => {
          if (item instanceof GDXViewerView) {
            item.destroy();
          }
        });
      })
    );
  },

  deserializeGDXViewerView(serialized) {
    return new GDXViewerView();
  },

  deactivate() {
    this.subscriptions.dispose();
  }

};
