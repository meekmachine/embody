(ns embody.entry
  (:require [embody.animation :as animation]))

;; Public ESM facade for `@lovelace_lol/embody/cljs`. Keep this namespace thin:
;; CLJS animation behavior belongs in `embody.animation`, and renderer-specific
;; JS interop belongs in the connector object supplied by the host.

(defn create-animation-runtime
  ([] (animation/create-runtime nil nil))
  ([config] (animation/create-runtime config nil))
  ([config connector] (animation/create-runtime config connector)))

(defn install-embody
  ([] (install-embody js/globalThis))
  ([target]
   (let [api #js {:createAnimationRuntime create-animation-runtime}]
     (aset target "Embody" api)
     api)))
