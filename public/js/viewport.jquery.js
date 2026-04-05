var _____WB$wombat$assign$function_____=function(name){return (self._wb_wombat && self._wb_wombat.local_init && self._wb_wombat.local_init(name))||self[name];};if(!self.__WB_pmw){self.__WB_pmw=function(obj){this.__WB_source=obj;return this;}}{
let window = _____WB$wombat$assign$function_____("window");
let self = _____WB$wombat$assign$function_____("self");
let document = _____WB$wombat$assign$function_____("document");
let location = _____WB$wombat$assign$function_____("location");
let top = _____WB$wombat$assign$function_____("top");
let parent = _____WB$wombat$assign$function_____("parent");
let frames = _____WB$wombat$assign$function_____("frames");
let opens = _____WB$wombat$assign$function_____("opens");
/* ====================================================
 * jQuery Is In Viewport.
 * https://github.com/frontid/jQueryIsInViewport
 * Marcelo IvÃƒÂ¡n Tosco (capynet)
 * Inspired on https://stackoverflow.com/a/40658647/1413049
 * ==================================================== */
!function ($) {
  'use strict'

  var Class = function (el, cb) {
    this.$el = $(el);
    this.cb = cb;
    this.watch();
    return this;
  };

  Class.prototype = {

    /**
     * Checks if the element is in.
     *
     * @returns {boolean}
     */
    isIn: function isIn() {
      var _self = this;
      var $win = $(window);
      var elementTop = _self.$el.offset().top;
      var elementBottom = elementTop + _self.$el.outerHeight();
      var viewportTop = $win.scrollTop();
      var viewportBottom = viewportTop + $win.height();
      return elementBottom > viewportTop && elementTop < viewportBottom;
    },

    /**
     * Launch a callback indicating when the element is in and when is out.
     */
    watch: function () {
      var _self = this;
      var _isIn = false;

      $(window).on('resize scroll', function () {

        if (_self.isIn() && _isIn === false) {
          _self.cb.call(_self.$el, 'entered');
          _isIn = true;
        }

        if (_isIn === true && !_self.isIn()) {
          _self.cb.call(_self.$el, 'leaved');
          _isIn = false;
        }

      })
    }


  };

  // jQuery plugin.
  //-----------------------------------------------------------
  $.fn.isInViewport = function (cb) {
    return this.each(function () {
      var $element = $(this);
      var data = $element.data('isInViewport');
      if (!data) {
        $element.data('isInViewport', (new Class(this, cb)));
      }
    })
  }

}(window.jQuery);
}

/*
     FILE ARCHIVED ON 07:19:00 Feb 09, 2026 AND RETRIEVED FROM THE
     INTERNET ARCHIVE ON 16:10:50 Apr 05, 2026.
     JAVASCRIPT APPENDED BY WAYBACK MACHINE, COPYRIGHT INTERNET ARCHIVE.

     ALL OTHER CONTENT MAY ALSO BE PROTECTED BY COPYRIGHT (17 U.S.C.
     SECTION 108(a)(3)).
*/
/*
playback timings (ms):
  captures_list: 0.752
  exclusion.robots: 0.066
  exclusion.robots.policy: 0.052
  esindex: 0.011
  cdx.remote: 14.883
  LoadShardBlock: 132.255 (3)
  PetaboxLoader3.datanode: 125.974 (4)
  PetaboxLoader3.resolve: 102.417 (2)
  load_resource: 119.396
*/