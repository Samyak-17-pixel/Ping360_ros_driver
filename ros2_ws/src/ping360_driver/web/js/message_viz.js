/**
 * JSON stringify with array truncation + message type → visual mode.
 */
(function (global) {
  var MAX_ARR = 48;

  function stringifyMsg(msg) {
    try {
      return JSON.stringify(
        msg,
        function (k, v) {
          if (k === "data" && typeof v === "string" && v.length > 120) {
            return v.substring(0, 80) + "… (" + v.length + " chars)";
          }
          if (Array.isArray(v) && v.length > MAX_ARR) {
            return v.slice(0, MAX_ARR).concat(["… (" + v.length + " elements total)"]);
          }
          return v;
        },
        2
      );
    } catch (e) {
      return String(msg);
    }
  }

  function visualMode(type) {
    if (!type) return "generic";
    if (type.indexOf("sensor_msgs/msg/Image") !== -1) return "image";
    if (type.indexOf("sensor_msgs/msg/LaserScan") !== -1) return "laser";
    if (type.indexOf("sensor_msgs/msg/CompressedImage") !== -1) return "compressed";
    if (type.indexOf("std_msgs/msg/Float32") !== -1 || type.indexOf("std_msgs/msg/Float64") !== -1) {
      return "scalar_float";
    }
    if (type.indexOf("std_msgs/msg/Int32") !== -1 || type.indexOf("std_msgs/msg/UInt32") !== -1) {
      return "scalar_int";
    }
    if (type.indexOf("std_msgs/msg/String") !== -1) return "string";
    if (type.indexOf("sensor_msgs/msg/Range") !== -1) return "range";
    if (type.indexOf("geometry_msgs/msg/Twist") !== -1) return "twist";
    if (type.indexOf("geometry_msgs/msg/TwistStamped") !== -1) return "twist";
    if (type.indexOf("geometry_msgs/msg/Vector3") !== -1) return "vector3";
    if (type.indexOf("sensor_msgs/msg/PointCloud2") !== -1) return "pointcloud2";
    return "generic";
  }

  function scalarSummary(msg, type) {
    if (msg.data !== undefined && typeof msg.data === "number") {
      return String(msg.data);
    }
    return stringifyMsg(msg);
  }

  global.Ping360MessageViz = {
    stringify: stringifyMsg,
    visualMode: visualMode,
    scalarSummary: scalarSummary,
  };
})(typeof window !== "undefined" ? window : globalThis);
