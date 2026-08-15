/**
 * Topic list via /rosapi/topics, filter, row selection, Hz for active topic.
 */
(function (global) {
  function initTopicExplorer(ros, options) {
    const tbody = document.getElementById("topic-rows");
    const filterEl = document.getElementById("topic-filter");
    const statusEl = document.getElementById("topic-list-status");
    const btnRefresh = document.getElementById("btn-refresh-topics");
    const inpManualTopic = document.getElementById("manual-topic");
    const inpManualType = document.getElementById("manual-type");
    const btnManualApply = document.getElementById("btn-manual-apply");

    let topics = [];
    let types = [];
    let selectedIndex = -1;
    let hzCount = 0;
    let hzLast = performance.now();
    let hzDisplay = 0;

    const topicsSrv = new ROSLIB.Service({
      ros: ros,
      name: "/rosapi/topics",
      serviceType: "rosapi_msgs/srv/Topics",
    });

    function refresh() {
      statusEl.textContent = "Loading…";
      topicsSrv.callService(new ROSLIB.ServiceRequest({}), function (res) {
        if (!res || !res.topics) {
          statusEl.textContent = "Failed (is rosapi running?) — use manual entry below.";
          return;
        }
        topics = res.topics || [];
        types = res.types || [];
        statusEl.textContent = topics.length + " topics";
        renderTable();
        if (options.onTopicsReady) {
          options.onTopicsReady(topics, types);
        }
      });
    }

    function renderTable() {
      const q = (filterEl.value || "").toLowerCase().trim();
      tbody.innerHTML = "";
      for (let i = 0; i < topics.length; i++) {
        const name = topics[i];
        const typ = types[i] || "?";
        if (q && name.toLowerCase().indexOf(q) < 0 && typ.toLowerCase().indexOf(q) < 0) {
          continue;
        }
        const tr = document.createElement("tr");
        tr.dataset.index = String(i);
        if (i === selectedIndex) tr.classList.add("selected");
        tr.innerHTML =
          '<td><button type="button" class="btn-link" data-action="pick">View</button></td>' +
          "<td class=\"mono topic-name\">" +
          escapeHtml(name) +
          "</td>" +
          "<td class=\"mono topic-type\">" +
          escapeHtml(typ) +
          "</td>" +
          '<td class="mono topic-hz" data-topic-idx="' +
          i +
          '">—</td>';
        tr.querySelector('[data-action="pick"]').addEventListener("click", function (e) {
          e.stopPropagation();
          selectByIndex(i);
        });
        tr.addEventListener("click", function () {
          selectByIndex(i);
        });
        tbody.appendChild(tr);
      }
    }

    function escapeHtml(s) {
      const d = document.createElement("div");
      d.textContent = s;
      return d.innerHTML;
    }

    function selectByIndex(i) {
      if (i < 0 || i >= topics.length) return;
      selectedIndex = i;
      hzCount = 0;
      hzLast = performance.now();
      hzDisplay = 0;
      renderTable();
      if (options.onSelect) {
        options.onSelect(topics[i], types[i]);
      }
    }

    function selectManual() {
      const name = (inpManualTopic.value || "").trim();
      const typ = (inpManualType.value || "").trim();
      if (!name || !typ) {
        statusEl.textContent = "Enter both topic name and message type.";
        return;
      }
      selectedIndex = -1;
      renderTable();
      if (options.onSelect) {
        options.onSelect(name, typ);
      }
    }

    function tickHzForSelectedTopic() {
      const now = performance.now();
      hzCount++;
      if (now - hzLast >= 1000) {
        hzDisplay = Math.round((hzCount * 1000) / (now - hzLast));
        hzCount = 0;
        hzLast = now;
        if (selectedIndex >= 0) {
          const el = tbody.querySelector('.topic-hz[data-topic-idx="' + selectedIndex + '"]');
          if (el) el.textContent = hzDisplay + " Hz";
        }
        if (options.onHz) options.onHz(hzDisplay);
      }
    }

    filterEl.addEventListener("input", renderTable);
    btnRefresh.addEventListener("click", refresh);
    btnManualApply.addEventListener("click", selectManual);

    ros.on("connection", function () {
      refresh();
    });
    if (typeof ros.isConnected !== "undefined" && ros.isConnected) {
      refresh();
    }

    return {
      refresh: refresh,
      selectByTopicName: function (name) {
        const i = topics.indexOf(name);
        if (i >= 0) selectByIndex(i);
      },
      tickHz: tickHzForSelectedTopic,
      getSelected: function () {
        if (selectedIndex >= 0) {
          return { name: topics[selectedIndex], type: types[selectedIndex] };
        }
        return null;
      },
    };
  }

  global.Ping360TopicExplorer = { init: initTopicExplorer };
})(typeof window !== "undefined" ? window : globalThis);
