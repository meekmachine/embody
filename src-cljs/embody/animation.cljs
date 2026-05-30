(ns embody.animation)

;; Embody's CLJS animation runtime owns clip-handle state and command planning.
;; The connector passed in from JavaScript is deliberately small: it performs
;; the renderer-specific Three.js mutations that cannot be represented as
;; serializable Clojure data, then reports playback events back through
;; `acceptClipEvent`.

(def default-state
  {:handles {}
   :order []
   :eventCount 0
   :lastEvent nil
   :lastUpdatedTime nil})

(defn- now-ms []
  (.round js/Math (.now js/Date)))

(defn- finite-number? [value]
  (and (number? value) (.isFinite js/Number value)))

(defn- number-or [value fallback]
  (if (finite-number? value) value fallback))

(defn- clamp [low high value]
  (let [n (number-or value low)]
    (cond
      (< n low) low
      (> n high) high
      :else n)))

(defn- js->data [value]
  (js->clj value :keywordize-keys true))

(defn- data->js [value]
  (clj->js value))

(defn- fn-prop [value key]
  (let [candidate (and value (aget value key))]
    (when (fn? candidate) candidate)))

(defn- call-connector! [connector names & args]
  (loop [remaining names]
    (when-let [name (first remaining)]
      (if-let [callback (fn-prop connector name)]
        (apply callback args)
        (recur (rest remaining))))))

(defn- key->string [value]
  (cond
    (keyword? value) (name value)
    (string? value) value
    (number? value) (str value)
    (nil? value) ""
    :else (str value)))

(defn- normalize-point [point]
  (let [point (or point {})]
    {:time (number-or (if (contains? point :time) (:time point) (:t point)) 0)
     :intensity (number-or (if (contains? point :intensity) (:intensity point) (:v point)) 0)
     :inherit (boolean (:inherit point))}))

(defn normalize-curves [curves]
  (if-not (map? curves)
    {}
    (into {}
          (map (fn [[curve-id points]]
                 [(key->string curve-id)
                  (->> (if (sequential? points) points [])
                       (map normalize-point)
                       (sort-by :time)
                       vec)]))
          curves)))

(defn- calculate-duration [curves fallback]
  (reduce
   (fn [duration points]
     (max duration (number-or (:time (last points)) duration)))
   (number-or fallback 0)
   (vals curves)))

(defn- normalize-loop-mode [options]
  (let [mode (or (:loopMode options) (:mixerLoopMode options))]
    (cond
      (#{"once" "repeat" "pingpong"} mode) mode
      (false? (:loop options)) "once"
      :else "repeat")))

(defn- normalize-options [options]
  (let [options (or options {})
        loop-mode (normalize-loop-mode options)
        rate (or (:playbackRate options) (:rate options) (:speed options))
        weight (or (:weight options) (:intensity options))]
    (cond-> {:weight (max 0 (number-or weight 1))
             :rate (max 0 (number-or rate 1))
             :loopMode loop-mode
             :loop (not= loop-mode "once")
             :repeatCount (:repeatCount options)
             :reverse (boolean (:reverse options))
             :source (or (:source options) "clip")
             :startTime (max 0 (number-or (:startTime options) 0))}
      (contains? options :blendMode) (assoc :blendMode (:blendMode options))
      (contains? options :easing) (assoc :easing (:easing options))
      (contains? options :balance) (assoc :balance (clamp -1 1 (:balance options)))
      (contains? options :balanceMap) (assoc :balanceMap (:balanceMap options))
      (contains? options :jawScale) (assoc :jawScale (max 0 (number-or (:jawScale options) 1)))
      (contains? options :intensityScale) (assoc :intensityScale (max 0 (number-or (:intensityScale options) 1)))
      (contains? options :snippetCategory) (assoc :snippetCategory (:snippetCategory options))
      (contains? options :autoVisemeJaw) (assoc :autoVisemeJaw (boolean (:autoVisemeJaw options))))))

(defn- make-action-id [clip-name]
  (str clip-name "#" (now-ms) "-" (.floor js/Math (* (.random js/Math) 1000000))))

(defn- handle-state
  [clip-name curves options connector-result]
  (let [result (or connector-result {})
        action-id (or (:actionId result) (:id result) (make-action-id clip-name))
        duration (calculate-duration curves (:duration result))]
    {:clipName clip-name
     :actionId action-id
     :duration duration
     :time (number-or (:time result) (:startTime options))
     :weight (:weight options)
     :rate (:rate options)
     :loopMode (:loopMode options)
     :loop (:loop options)
     :repeatCount (:repeatCount options)
     :reverse (:reverse options)
     :source (:source options)
     :status "playing"
     :createdAt (now-ms)
     :updatedAt (now-ms)}))

(defn- upsert-handle! [state handle]
  (swap! state
         (fn [current]
           (let [clip-name (:clipName handle)]
             (-> current
                 (assoc-in [:handles clip-name] handle)
                 (update :order (fn [order]
                                  (if (some #(= clip-name %) order)
                                    (vec order)
                                    (conj (vec order) clip-name))))
                 (assoc :lastUpdatedTime (now-ms)))))))

(defn- remove-handle! [state clip-name]
  (swap! state
         (fn [current]
           (-> current
               (update :handles dissoc clip-name)
               (update :order (fn [order] (vec (remove #(= clip-name %) order))))
               (assoc :lastUpdatedTime (now-ms))))))

(defn- update-handle! [state clip-name f & args]
  (swap! state
         (fn [current]
           (if (get-in current [:handles clip-name])
             (-> current
                 (update-in [:handles clip-name] #(apply f % args))
                 (assoc :lastUpdatedTime (now-ms)))
             current))))

(defn- emit-state! [connector state]
  (when-let [on-state (fn-prop connector "onState")]
    (on-state (data->js @state))))

(defn- emit-command! [connector command]
  (when-let [on-command (fn-prop connector "onCommand")]
    (on-command (data->js command))))

(defn- notify-listeners! [listeners clip-name event]
  (doseq [listener (get @listeners clip-name)]
    (try
      (listener (data->js event))
      (catch :default error
        (js/console.error "[Embody CLJS] clip listener failed" error)))))

(defn- resolve-finished! [finishers clip-name]
  (when-let [resolve (get @finishers clip-name)]
    (resolve)
    (swap! finishers dissoc clip-name)))

(defn- command!
  [state connector op clip-name payload]
  (let [command (merge {:type "clipCommand"
                        :op op
                        :clipName clip-name
                        :timestamp (now-ms)}
                       payload)]
    (emit-command! connector command)
    command))

(defn- call-clip-command!
  [state connector op callback-names clip-name payload & args]
  (command! state connector op clip-name payload)
  (apply call-connector! connector callback-names clip-name args)
  (emit-state! connector state))

(defn create-runtime
  ([] (create-runtime nil nil))
  ([config connector]
   (let [state (atom (merge default-state (or (js->data config) {})))
         connector (or connector #js {})
         listeners (atom {})
         finishers (atom {})]
     (letfn [(snapshot []
               (data->js @state))
             (accept-event! [event-js]
               (let [event (js->data event-js)
                     clip-name (key->string (or (:clipName event) (:name event)))
                     event-type (or (:type event) (:event event))]
                 (when-not (= "" clip-name)
                   (case event-type
                     ("time" "progress" "frame")
                     (update-handle! state clip-name assoc
                                     :time (number-or (:currentTime event) (:time event))
                                     :updatedAt (now-ms))

                     ("paused")
                     (update-handle! state clip-name assoc
                                     :status "paused"
                                     :updatedAt (now-ms))

                     ("resumed" "started" "played")
                     (update-handle! state clip-name assoc
                                     :status "playing"
                                     :updatedAt (now-ms))

                     ("completed" "finished")
                     (do
                       (update-handle! state clip-name assoc
                                       :status "completed"
                                       :time (get-in @state [:handles clip-name :duration])
                                       :updatedAt (now-ms))
                       (resolve-finished! finishers clip-name))

                     ("stopped" "removed")
                     (do
                       (update-handle! state clip-name assoc
                                       :status "stopped"
                                       :updatedAt (now-ms))
                       (resolve-finished! finishers clip-name))

                     nil)
                   (swap! state update :eventCount inc)
                   (swap! state assoc :lastEvent (assoc event :timestamp (now-ms)))
                   (notify-listeners! listeners clip-name event)
                   (emit-state! connector state))
                 true))
             (build-clip! [clip-name-js curves-js options-js]
               (let [clip-name (key->string clip-name-js)
                     curves (normalize-curves (js->data curves-js))
                     options (normalize-options (js->data options-js))
                     connector-result (js->data
                                       (call-connector! connector
                                                        ["buildClip" "playClip"]
                                                        clip-name
                                                        (data->js curves)
                                                        (data->js options)))
                     handle (handle-state clip-name curves options connector-result)]
                 (upsert-handle! state handle)
                 (command! state connector "buildClip" clip-name
                           {:actionId (:actionId handle)
                            :duration (:duration handle)
                            :options options})
                 (emit-state! connector state)
                 (make-handle clip-name)))
             (make-handle [clip-name]
               (let [finished (js/Promise.
                               (fn [resolve _reject]
                                 (swap! finishers assoc clip-name resolve)))]
                 #js {:clipName clip-name
                      :actionId (get-in @state [:handles clip-name :actionId])
                      :play (fn []
                              (update-handle! state clip-name assoc
                                              :status "playing"
                                              :updatedAt (now-ms))
                              (call-clip-command! state connector "play" ["playClip" "play"] clip-name {}))
                      :stop (fn []
                              (update-handle! state clip-name assoc
                                              :status "stopped"
                                              :updatedAt (now-ms))
                              (call-clip-command! state connector "stop" ["stopClip" "stop"] clip-name {})
                              (resolve-finished! finishers clip-name))
                      :pause (fn []
                               (update-handle! state clip-name assoc
                                               :status "paused"
                                               :updatedAt (now-ms))
                               (call-clip-command! state connector "pause" ["pauseClip" "pause"] clip-name {}))
                      :resume (fn []
                                (update-handle! state clip-name assoc
                                                :status "playing"
                                                :updatedAt (now-ms))
                                (call-clip-command! state connector "resume" ["resumeClip" "resume"] clip-name {}))
                      :setWeight (fn [weight]
                                   (let [weight (max 0 (number-or weight 1))]
                                     (update-handle! state clip-name assoc
                                                     :weight weight
                                                     :updatedAt (now-ms))
                                     (call-clip-command! state connector
                                                         "setWeight"
                                                         ["setClipWeight" "setWeight"]
                                                         clip-name
                                                         {:weight weight}
                                                         weight)))
                      :setPlaybackRate (fn [rate]
                                         (let [rate (max 0 (number-or rate 1))]
                                           (update-handle! state clip-name assoc
                                                           :rate rate
                                                           :updatedAt (now-ms))
                                           (call-clip-command! state connector
                                                               "setPlaybackRate"
                                                               ["setClipPlaybackRate" "setPlaybackRate"]
                                                               clip-name
                                                               {:rate rate}
                                                               rate)))
                      :setLoop (fn [mode repeat-count]
                                 (let [mode (if (#{"once" "repeat" "pingpong"} mode) mode "repeat")]
                                   (update-handle! state clip-name assoc
                                                   :loopMode mode
                                                   :loop (not= mode "once")
                                                   :repeatCount repeat-count
                                                   :updatedAt (now-ms))
                                   (call-clip-command! state connector
                                                       "setLoop"
                                                       ["setClipLoop" "setLoop"]
                                                       clip-name
                                                       {:loopMode mode
                                                        :repeatCount repeat-count}
                                                       mode
                                                       repeat-count)))
                      :setTime (fn [time]
                                 (let [duration (get-in @state [:handles clip-name :duration])
                                       time (clamp 0 duration time)]
                                   (update-handle! state clip-name assoc
                                                   :time time
                                                   :updatedAt (now-ms))
                                   (call-clip-command! state connector
                                                       "setTime"
                                                       ["setClipTime" "setTime"]
                                                       clip-name
                                                       {:time time}
                                                       time)))
                      :getTime (fn []
                                 (or (call-connector! connector ["getClipTime" "getTime"] clip-name)
                                     (get-in @state [:handles clip-name :time])
                                     0))
                      :getDuration (fn []
                                     (or (call-connector! connector ["getClipDuration" "getDuration"] clip-name)
                                         (get-in @state [:handles clip-name :duration])
                                         0))
                      :subscribe (fn [listener]
                                   (swap! listeners update clip-name (fnil conj #{}) listener)
                                   (fn []
                                     (swap! listeners update clip-name disj listener)))
                      :finished finished}))]
       #js {:snapshot snapshot
            :buildClip build-clip!
            :playSnippet build-clip!
            :acceptClipEvent accept-event!
            :cleanupSnippet (fn [name-js]
                              (let [clip-name (key->string name-js)]
                                (remove-handle! state clip-name)
                                (call-clip-command! state connector
                                                    "cleanupSnippet"
                                                    ["cleanupSnippet" "removeClip"]
                                                    clip-name {})
                                true))
            :updateClipParams (fn [name-js params-js]
                                (let [clip-name (key->string name-js)
                                      params (js->data params-js)
                                      action-id (:actionId params)]
                                  (update-handle! state clip-name
                                                  (fn [handle]
                                                    (cond-> handle
                                                      (finite-number? (:weight params)) (assoc :weight (max 0 (:weight params)))
                                                      (finite-number? (:rate params)) (assoc :rate (max 0 (:rate params)))
                                                      (:loopMode params) (assoc :loopMode (:loopMode params)
                                                                                :loop (not= (:loopMode params) "once"))
                                                      (contains? params :reverse) (assoc :reverse (boolean (:reverse params)))
                                                      true (assoc :updatedAt (now-ms)))))
                                  (call-clip-command! state connector
                                                      "updateClipParams"
                                                      ["updateClipParams"]
                                                      clip-name
                                                      {:params params
                                                       :actionId action-id}
                                                      (data->js params))
                                  true))}))))
